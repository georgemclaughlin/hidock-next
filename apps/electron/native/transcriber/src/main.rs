use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};
use tar::Archive;
use transcribe_rs::{
    onnx::{
        parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity},
        Quantization,
    },
    whisper_cpp::{WhisperEngine, WhisperInferenceParams},
};

const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Parser)]
#[command(name = "hidock-transcriber")]
#[command(about = "Local HiDock transcription sidecar")]
struct Cli {
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Models,
    Download {
        model_id: String,
    },
    Transcribe {
        #[arg(long)]
        model_id: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "auto")]
        language: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum EngineType {
    Whisper,
    Parakeet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelInfo {
    id: String,
    name: String,
    description: String,
    filename: String,
    url: String,
    sha256: String,
    size_mb: u64,
    is_directory: bool,
    is_downloaded: bool,
    engine_type: EngineType,
}

#[derive(Debug, Serialize)]
struct TranscriptOutput {
    text: String,
    language: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Serialize)]
struct TranscriptSegment {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let models_dir = models_dir(cli.data_dir.as_deref())?;
    fs::create_dir_all(&models_dir)
        .with_context(|| format!("Failed to create models directory {}", models_dir.display()))?;

    match cli.command {
        Command::Models => {
            let mut models = catalog();
            for model in models.values_mut() {
                model.is_downloaded = is_model_downloaded(&models_dir, model);
            }
            print_json(&models.values().cloned().collect::<Vec<_>>())
        }
        Command::Download { model_id } => {
            let model = get_model(&model_id)?;
            download_model(&models_dir, &model)?;
            print_json(&serde_json::json!({ "success": true, "model_id": model.id }))
        }
        Command::Transcribe {
            model_id,
            input,
            output,
            language,
        } => {
            let model = get_model(&model_id)?;
            if !is_model_downloaded(&models_dir, &model) {
                return Err(anyhow!("Model is not downloaded: {}", model_id));
            }

            let result = transcribe(&models_dir, &model, &input, &language)?;
            let json = serde_json::to_vec_pretty(&result)?;
            fs::write(&output, json).with_context(|| {
                format!("Failed to write transcript output {}", output.display())
            })?;
            print_json(&serde_json::json!({ "success": true, "output": output }))
        }
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn models_dir(data_dir: Option<&Path>) -> Result<PathBuf> {
    if let Some(data_dir) = data_dir {
        return Ok(data_dir.join("models"));
    }

    let base =
        dirs::data_dir().ok_or_else(|| anyhow!("Could not determine local app data directory"))?;
    Ok(base.join("HiDock").join("models"))
}

fn catalog() -> HashMap<String, ModelInfo> {
    let mut models = HashMap::new();

    insert_model(
        &mut models,
        ModelInfo {
            id: "whisper-small".to_string(),
            name: "Whisper Small".to_string(),
            description: "CPU-capable Whisper model with modest resource usage.".to_string(),
            filename: "ggml-small.bin".to_string(),
            url: "https://blob.handy.computer/ggml-small.bin".to_string(),
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b".to_string(),
            size_mb: 465,
            is_directory: false,
            is_downloaded: false,
            engine_type: EngineType::Whisper,
        },
    );

    insert_model(
        &mut models,
        ModelInfo {
            id: "whisper-medium".to_string(),
            name: "Whisper Medium".to_string(),
            description: "More accurate Whisper model; slower on CPU.".to_string(),
            filename: "whisper-medium-q4_1.bin".to_string(),
            url: "https://blob.handy.computer/whisper-medium-q4_1.bin".to_string(),
            sha256: "79283fc1f9fe12ca3248543fbd54b73292164d8df5a16e095e2bceeaaabddf57".to_string(),
            size_mb: 469,
            is_directory: false,
            is_downloaded: false,
            engine_type: EngineType::Whisper,
        },
    );

    insert_model(
        &mut models,
        ModelInfo {
            id: "parakeet-v3".to_string(),
            name: "Parakeet V3".to_string(),
            description: "CPU-optimized Parakeet V3 INT8 model.".to_string(),
            filename: "parakeet-tdt-0.6b-v3-int8".to_string(),
            url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz".to_string(),
            sha256: "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77".to_string(),
            size_mb: 456,
            is_directory: true,
            is_downloaded: false,
            engine_type: EngineType::Parakeet,
        },
    );

    models
}

fn insert_model(models: &mut HashMap<String, ModelInfo>, model: ModelInfo) {
    models.insert(model.id.clone(), model);
}

fn get_model(model_id: &str) -> Result<ModelInfo> {
    catalog()
        .remove(model_id)
        .ok_or_else(|| anyhow!("Unknown model: {}", model_id))
}

fn is_model_downloaded(models_dir: &Path, model: &ModelInfo) -> bool {
    let path = models_dir.join(&model.filename);
    if model.is_directory {
        path.is_dir()
    } else {
        path.is_file()
    }
}

fn download_model(models_dir: &Path, model: &ModelInfo) -> Result<()> {
    let final_path = models_dir.join(&model.filename);
    if is_model_downloaded(models_dir, model) {
        return Ok(());
    }

    let partial_path = models_dir.join(format!("{}.partial", model.filename));
    let mut response = reqwest::blocking::get(&model.url)
        .with_context(|| format!("Failed to start model download from {}", model.url))?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "Failed to download model: HTTP {}",
            response.status()
        ));
    }

    let mut file = File::create(&partial_path)
        .with_context(|| format!("Failed to create {}", partial_path.display()))?;
    response
        .copy_to(&mut file)
        .with_context(|| format!("Failed while downloading {}", model.id))?;
    file.flush()?;
    drop(file);

    verify_sha256(&partial_path, &model.sha256)
        .with_context(|| format!("Failed to verify downloaded model {}", model.id))?;

    if model.is_directory {
        let extract_dir = models_dir.join(format!("{}.extracting", model.filename));
        if extract_dir.exists() {
            fs::remove_dir_all(&extract_dir)?;
        }
        fs::create_dir_all(&extract_dir)?;

        let tar_gz = File::open(&partial_path)?;
        let tar = GzDecoder::new(tar_gz);
        let mut archive = Archive::new(tar);
        archive.unpack(&extract_dir)?;

        if final_path.exists() {
            fs::remove_dir_all(&final_path)?;
        }

        let extracted_dirs = fs::read_dir(&extract_dir)?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false))
            .collect::<Vec<_>>();

        if extracted_dirs.len() == 1 {
            fs::rename(extracted_dirs[0].path(), &final_path)?;
            let _ = fs::remove_dir_all(&extract_dir);
        } else {
            fs::rename(&extract_dir, &final_path)?;
        }

        let _ = fs::remove_file(&partial_path);
    } else {
        fs::rename(&partial_path, &final_path)?;
    }

    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<()> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(path);
        return Err(anyhow!(
            "SHA256 mismatch: expected {}, got {}",
            expected,
            actual
        ));
    }
    Ok(())
}

fn transcribe(
    models_dir: &Path,
    model: &ModelInfo,
    input: &Path,
    language: &str,
) -> Result<TranscriptOutput> {
    let audio = read_audio_as_f32(input)?;
    let model_path = models_dir.join(&model.filename);

    let text = match model.engine_type {
        EngineType::Whisper => {
            let mut engine = WhisperEngine::load(&model_path)
                .with_context(|| format!("Failed to load Whisper model {}", model.id))?;
            let params = WhisperInferenceParams {
                language: if language == "auto" {
                    None
                } else {
                    Some(language.to_string())
                },
                ..Default::default()
            };
            let result = engine
                .transcribe_with(&audio, &params)
                .with_context(|| format!("Whisper transcription failed for {}", input.display()))?;
            result.text
        }
        EngineType::Parakeet => {
            let mut engine = ParakeetModel::load(&model_path, &Quantization::Int8)
                .with_context(|| format!("Failed to load Parakeet model {}", model.id))?;
            let params = ParakeetParams {
                timestamp_granularity: Some(TimestampGranularity::Segment),
                ..Default::default()
            };
            let result = engine.transcribe_with(&audio, &params).with_context(|| {
                format!("Parakeet transcription failed for {}", input.display())
            })?;
            result.text
        }
    };

    Ok(TranscriptOutput {
        text,
        language: language.to_string(),
        segments: Vec::new(),
    })
}

fn read_audio_as_f32(path: &Path) -> Result<Vec<f32>> {
    let file = File::open(path)
        .with_context(|| format!("Failed to open audio file {}", path.display()))?;

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let media_source = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = get_probe()
        .format(
            &hint,
            media_source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .with_context(|| format!("Failed to detect audio format for {}", path.display()))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("No supported audio track found in {}", path.display()))?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("Audio track is missing a sample rate: {}", path.display()))?;
    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .with_context(|| format!("Failed to create audio decoder for {}", path.display()))?;

    let mut mono_samples = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(anyhow!(
                    "Audio decoder reset is not supported for {}",
                    path.display()
                ))
            }
            Err(error) => {
                return Err(anyhow!(
                    "Failed to read audio packet from {}: {}",
                    path.display(),
                    error
                ))
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let channel_count = decoded.spec().channels.count();
                if channel_count == 0 {
                    return Err(anyhow!("Audio track has no channels: {}", path.display()));
                }

                let mut sample_buffer =
                    SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
                sample_buffer.copy_interleaved_ref(decoded);

                for frame in sample_buffer.samples().chunks(channel_count) {
                    let mono = frame.iter().copied().sum::<f32>() / channel_count as f32;
                    mono_samples.push(mono.clamp(-1.0, 1.0));
                }
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => {
                return Err(anyhow!(
                    "Failed to decode audio from {}: {}",
                    path.display(),
                    error
                ))
            }
        }
    }

    if mono_samples.is_empty() {
        return Err(anyhow!(
            "Audio file did not contain decodable samples: {}",
            path.display()
        ));
    }

    Ok(resample_linear(
        &mono_samples,
        sample_rate,
        TARGET_SAMPLE_RATE,
    ))
}

fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let output_len = ((samples.len() as f64 * target_rate as f64) / source_rate as f64)
        .round()
        .max(1.0) as usize;
    let step = source_rate as f64 / target_rate as f64;
    let mut output = Vec::with_capacity(output_len);

    for index in 0..output_len {
        let source_position = index as f64 * step;
        let left_index = source_position.floor() as usize;
        let right_index = (left_index + 1).min(samples.len() - 1);
        let fraction = (source_position - left_index as f64) as f32;
        let left = samples[left_index];
        let right = samples[right_index];
        output.push((left + (right - left) * fraction).clamp(-1.0, 1.0));
    }

    output
}
