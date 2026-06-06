use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use flate2::read::GzDecoder;
use polyvoice::{
    clusterer::KMeansClusterer,
    models::ModelRegistry,
    pipeline_v2::hybrid::HybridPipeline,
    segmentation::PowersetSegmenter,
    types::{Profile, SampleRate, SpeakerTurn},
    Embedder, EmbedderError, ResNet34Adapter,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};
use tar::Archive;
use transcribe_rs::onnx::{
    parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity},
    Quantization,
};
#[cfg(not(windows))]
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const CLI_THREAD_STACK_SIZE: usize = 64 * 1024 * 1024;
const DOWNLOAD_PROGRESS_PREFIX: &str = "LR_PROGRESS ";
const TRANSCRIPTION_PROGRESS_PREFIX: &str = "LR_TRANSCRIBE_PROGRESS ";
const TRANSCRIPTION_TAIL_GAP_SECS: f32 = 1.5;
const TRANSCRIPTION_TAIL_CONTEXT_SECS: f32 = 2.0;
const TRANSCRIPTION_TAIL_WORD_GRACE_SECS: f32 = 0.15;
const MIN_TAIL_RETRY_SECS: f32 = 1.0;
const MIN_TAIL_RETRY_RMS: f32 = 0.0015;
const PARAKEET_CHUNKING_THRESHOLD_SECS: f32 = 10.0 * 60.0;
const PARAKEET_CHUNK_SECS: f32 = 5.0 * 60.0;
const PARAKEET_CHUNK_OVERLAP_SECS: f32 = 2.0;
const DIARIZATION_MAX_FULL_AUDIO_SECS: f32 = 60.0 * 60.0;
const TRANSCRIPT_SEGMENT_MERGE_GAP_SECS: f64 = 0.8;
const TRANSCRIPT_SEGMENT_MAX_SECS: f64 = 18.0;
const TRANSCRIPT_SEGMENT_MAX_CHARS: usize = 320;
const SHORT_SPEAKER_RUN_MAX_SECS: f64 = 3.2;
const SHORT_SPEAKER_RUN_MAX_WORDS: usize = 3;
const DEFAULT_TEXT_EMBEDDING_MODEL_ID: &str = "bge-small-en-v1.5-q";
const PARAKEET_CHECKPOINT_VERSION: u8 = 1;

#[derive(Parser)]
#[command(name = "recorder-transcriber")]
#[command(about = "Local Recorder transcription sidecar")]
struct Cli {
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Models,
    EmbeddingModels,
    Download {
        model_id: String,
    },
    DownloadEmbedding {
        model_id: String,
    },
    Embed {
        #[arg(long)]
        model_id: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum, default_value_t = TextEmbeddingInputType::Document)]
        input_type: TextEmbeddingInputType,
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
        #[arg(long)]
        disable_diarization: bool,
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

#[derive(Debug, Clone)]
struct TextEmbeddingCatalogEntry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    model: EmbeddingModel,
    dimensions: usize,
    document_prefix: &'static str,
    query_prefix: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TextEmbeddingModelInfo {
    id: String,
    name: String,
    description: String,
    dimensions: usize,
    provider: String,
    is_downloaded: bool,
}

#[derive(Debug, Deserialize)]
struct TextEmbeddingRequest {
    texts: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TextEmbeddingOutput {
    model_id: String,
    provider: String,
    dimensions: usize,
    embeddings: Vec<Vec<f32>>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum TextEmbeddingInputType {
    Document,
    Query,
}

#[derive(Debug, Serialize)]
struct TranscriptOutput {
    text: String,
    language: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptSegment {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker: Option<String>,
}

struct TranscribeRunOutput {
    transcript: TranscriptOutput,
    checkpoint_dir: Option<PathBuf>,
}

struct ParakeetRunOutput {
    result: transcribe_rs::TranscriptionResult,
    checkpoint_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ParakeetCheckpointManifest {
    version: u8,
    input_path: String,
    input_size: u64,
    input_modified_unix_nanos: String,
    model_id: String,
    sample_rate: u32,
    audio_samples: usize,
    primary_chunk_samples: usize,
    overlap_samples: usize,
    total_chunks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ParakeetChunkCheckpoint {
    version: u8,
    chunk_index: usize,
    total_chunks: usize,
    text: String,
    segments: Vec<CheckpointSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointSegment {
    start: f32,
    end: f32,
    text: String,
}

struct ParakeetCheckpoint {
    dir: PathBuf,
    manifest: ParakeetCheckpointManifest,
}

#[derive(Debug, Serialize)]
struct DownloadProgressEvent<'a> {
    model: &'a str,
    stage: &'a str,
    progress: u8,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
struct TranscriptionProgressEvent<'a> {
    stage: &'a str,
    progress: u8,
}

struct SerialEmbedder<E: Embedder> {
    inner: Mutex<E>,
    dim: usize,
}

impl<E: Embedder> SerialEmbedder<E> {
    fn new(inner: E) -> Self {
        let dim = inner.dim();
        Self {
            inner: Mutex::new(inner),
            dim,
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, E>, EmbedderError> {
        self.inner
            .lock()
            .map_err(|_| EmbedderError::Legacy("serialized embedder lock poisoned".to_string()))
    }
}

impl<E: Embedder> Embedder for SerialEmbedder<E> {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, audio: &[f32]) -> Result<Vec<f32>, EmbedderError> {
        self.lock()?.embed(audio)
    }

    fn embed_batch(&self, audios: &[&[f32]]) -> Result<Vec<Vec<f32>>, EmbedderError> {
        let guard = self.lock()?;
        audios.iter().map(|audio| guard.embed(audio)).collect()
    }
}

fn main() -> Result<()> {
    let worker = std::thread::Builder::new()
        .name("recorder-transcriber-cli".to_string())
        .stack_size(CLI_THREAD_STACK_SIZE)
        .spawn(run_cli)
        .context("Failed to start recorder transcriber CLI thread")?;

    match worker.join() {
        Ok(result) => result,
        Err(panic) => {
            let message = if let Some(message) = panic.downcast_ref::<&str>() {
                (*message).to_string()
            } else if let Some(message) = panic.downcast_ref::<String>() {
                message.clone()
            } else {
                "unknown panic payload".to_string()
            };
            Err(anyhow!(
                "Recorder transcriber CLI thread panicked: {message}"
            ))
        }
    }
}

fn run_cli() -> Result<()> {
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
        Command::EmbeddingModels => {
            let cache_dir = text_embeddings_cache_dir(&models_dir);
            fs::create_dir_all(&cache_dir).with_context(|| {
                format!(
                    "Failed to create text embeddings cache directory {}",
                    cache_dir.display()
                )
            })?;
            let models = text_embedding_catalog()
                .into_iter()
                .map(|entry| TextEmbeddingModelInfo {
                    id: entry.id.to_string(),
                    name: entry.name.to_string(),
                    description: entry.description.to_string(),
                    dimensions: entry.dimensions,
                    provider: "native-fastembed".to_string(),
                    is_downloaded: is_text_embedding_model_downloaded(&cache_dir, &entry),
                })
                .collect::<Vec<_>>();
            print_json(&models)
        }
        Command::Download { model_id } => {
            let model = get_model(&model_id)?;
            download_model(&models_dir, &model)?;
            print_json(&serde_json::json!({ "success": true, "model_id": model.id }))
        }
        Command::DownloadEmbedding { model_id } => {
            let entry = get_text_embedding_model(&model_id)?;
            let cache_dir = text_embeddings_cache_dir(&models_dir);
            fs::create_dir_all(&cache_dir).with_context(|| {
                format!(
                    "Failed to create text embeddings cache directory {}",
                    cache_dir.display()
                )
            })?;

            build_text_embedding_model(&cache_dir, &entry, true)?;
            print_json(&serde_json::json!({
                "success": true,
                "model_id": entry.id,
                "provider": "native-fastembed",
                "dimensions": entry.dimensions
            }))
        }
        Command::Embed {
            model_id,
            input,
            input_type,
        } => {
            let entry = get_text_embedding_model(&model_id)?;
            let cache_dir = text_embeddings_cache_dir(&models_dir);
            fs::create_dir_all(&cache_dir).with_context(|| {
                format!(
                    "Failed to create text embeddings cache directory {}",
                    cache_dir.display()
                )
            })?;

            let request = read_text_embedding_request(&input)?;
            let output = embed_texts(&cache_dir, &entry, input_type, request)?;
            print_json(&output)
        }
        Command::Transcribe {
            model_id,
            input,
            output,
            language,
            disable_diarization,
        } => {
            let model = get_model(&model_id)?;
            if !is_model_downloaded(&models_dir, &model) {
                return Err(anyhow!("Model is not downloaded: {}", model_id));
            }

            let result = transcribe(&models_dir, &model, &input, &language, !disable_diarization)?;
            let json = serde_json::to_vec_pretty(&result.transcript)?;
            fs::write(&output, json).with_context(|| {
                format!("Failed to write transcript output {}", output.display())
            })?;
            if let Some(checkpoint_dir) = result.checkpoint_dir {
                if let Err(error) = fs::remove_dir_all(&checkpoint_dir) {
                    eprintln!(
                        "Failed to remove transcription checkpoint {}: {error}",
                        checkpoint_dir.display()
                    );
                }
            }
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
    Ok(base.join("LocalRecorder").join("models"))
}

fn text_embeddings_cache_dir(models_dir: &Path) -> PathBuf {
    models_dir.join("text-embeddings")
}

fn text_embedding_catalog() -> Vec<TextEmbeddingCatalogEntry> {
    vec![
        TextEmbeddingCatalogEntry {
            id: "bge-small-en-v1.5-q",
            name: "BGE Small English v1.5 Q",
            description: "Fast 384-dimensional quantized English embedding model for local semantic search.",
            model: EmbeddingModel::BGESmallENV15Q,
            dimensions: 384,
            document_prefix: "",
            query_prefix: "Represent this sentence for searching relevant passages: ",
        },
        TextEmbeddingCatalogEntry {
            id: "nomic-embed-text-v1.5-q",
            name: "Nomic Embed Text v1.5 Q",
            description: "768-dimensional quantized English embedding model with long context and existing Ollama continuity.",
            model: EmbeddingModel::NomicEmbedTextV15Q,
            dimensions: 768,
            document_prefix: "search_document: ",
            query_prefix: "search_query: ",
        },
        TextEmbeddingCatalogEntry {
            id: "bge-m3",
            name: "BGE M3",
            description: "1024-dimensional multilingual embedding model for advanced local semantic search.",
            model: EmbeddingModel::BGEM3,
            dimensions: 1024,
            document_prefix: "",
            query_prefix: "Represent this sentence for searching relevant passages: ",
        },
    ]
}

fn normalize_text_embedding_model_id(model_id: &str) -> String {
    let normalized = model_id.trim().to_lowercase();
    match normalized.as_str() {
        "" => DEFAULT_TEXT_EMBEDDING_MODEL_ID.to_string(),
        "bge-small-en-v1.5" | "bge-small" => "bge-small-en-v1.5-q".to_string(),
        "nomic-embed-text" | "nomic-embed-text-v1.5" => "nomic-embed-text-v1.5-q".to_string(),
        other => other.to_string(),
    }
}

fn get_text_embedding_model(model_id: &str) -> Result<TextEmbeddingCatalogEntry> {
    let normalized = normalize_text_embedding_model_id(model_id);
    text_embedding_catalog()
        .into_iter()
        .find(|entry| entry.id == normalized)
        .ok_or_else(|| anyhow!("Unknown text embedding model: {}", model_id))
}

fn text_embedding_intra_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(1, 4))
        .unwrap_or(4)
}

fn build_text_embedding_model(
    cache_dir: &Path,
    entry: &TextEmbeddingCatalogEntry,
    show_download_progress: bool,
) -> Result<TextEmbedding> {
    TextEmbedding::try_new(
        TextInitOptions::new(entry.model.clone())
            .with_cache_dir(cache_dir.to_path_buf())
            .with_show_download_progress(show_download_progress)
            .with_intra_threads(text_embedding_intra_threads()),
    )
    .with_context(|| format!("Failed to initialize text embedding model {}", entry.id))
}

fn is_text_embedding_model_downloaded(cache_dir: &Path, entry: &TextEmbeddingCatalogEntry) -> bool {
    let Ok(model_info) = TextEmbedding::get_model_info(&entry.model) else {
        return false;
    };
    let repo_dir = cache_dir.join(format!(
        "models--{}",
        model_info.model_code.replace('/', "--")
    ));
    let snapshots_dir = repo_dir.join("snapshots");
    snapshots_dir
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn read_text_embedding_request(input: &Path) -> Result<TextEmbeddingRequest> {
    let bytes = fs::read(input)
        .with_context(|| format!("Failed to read embedding input {}", input.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("Failed to parse embedding input {}", input.display()))
}

fn prepare_text_embedding_input(
    entry: &TextEmbeddingCatalogEntry,
    input_type: TextEmbeddingInputType,
    text: &str,
) -> String {
    let trimmed = text.trim();
    let prefix = match input_type {
        TextEmbeddingInputType::Document => entry.document_prefix,
        TextEmbeddingInputType::Query => entry.query_prefix,
    };

    if prefix.is_empty() || trimmed.starts_with(prefix) {
        trimmed.to_string()
    } else {
        format!("{prefix}{trimmed}")
    }
}

fn embed_texts(
    cache_dir: &Path,
    entry: &TextEmbeddingCatalogEntry,
    input_type: TextEmbeddingInputType,
    request: TextEmbeddingRequest,
) -> Result<TextEmbeddingOutput> {
    if request.texts.is_empty() {
        return Ok(TextEmbeddingOutput {
            model_id: entry.id.to_string(),
            provider: "native-fastembed".to_string(),
            dimensions: entry.dimensions,
            embeddings: Vec::new(),
        });
    }

    let texts = request
        .texts
        .iter()
        .map(|text| prepare_text_embedding_input(entry, input_type, text))
        .collect::<Vec<_>>();
    let mut model = build_text_embedding_model(cache_dir, entry, false)?;
    let embeddings = model
        .embed(&texts, None)
        .with_context(|| format!("Failed to generate text embeddings with {}", entry.id))?;

    Ok(TextEmbeddingOutput {
        model_id: entry.id.to_string(),
        provider: "native-fastembed".to_string(),
        dimensions: entry.dimensions,
        embeddings,
    })
}

fn catalog() -> HashMap<String, ModelInfo> {
    let mut models = HashMap::new();

    insert_whisper_models(&mut models);

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

#[cfg(not(windows))]
fn insert_whisper_models(models: &mut HashMap<String, ModelInfo>) {
    insert_model(
        models,
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
        models,
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
}

#[cfg(windows)]
fn insert_whisper_models(_models: &mut HashMap<String, ModelInfo>) {}

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
        emit_download_progress(model, "ready", 100, None, None);
        return Ok(());
    }

    let partial_path = models_dir.join(format!("{}.partial", model.filename));
    emit_download_progress(model, "starting", 0, None, None);

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
    let total_bytes = response
        .content_length()
        .or_else(|| Some(model.size_mb.saturating_mul(1024 * 1024)))
        .filter(|bytes| *bytes > 0);
    let mut downloaded_bytes = 0_u64;
    let mut last_progress = 0_u8;
    let mut buffer = [0_u8; 64 * 1024];

    emit_download_progress(model, "downloading", 0, Some(0), total_bytes);
    loop {
        let bytes_read = response
            .read(&mut buffer)
            .with_context(|| format!("Failed while downloading {}", model.id))?;
        if bytes_read == 0 {
            break;
        }

        file.write_all(&buffer[..bytes_read])
            .with_context(|| format!("Failed to write {}", partial_path.display()))?;
        downloaded_bytes = downloaded_bytes.saturating_add(bytes_read as u64);

        if let Some(total) = total_bytes {
            let progress = ((downloaded_bytes.saturating_mul(85)) / total).min(85) as u8;
            if progress != last_progress {
                emit_download_progress(
                    model,
                    "downloading",
                    progress,
                    Some(downloaded_bytes),
                    Some(total),
                );
                last_progress = progress;
            }
        }
    }

    emit_download_progress(
        model,
        "downloading",
        85,
        Some(downloaded_bytes),
        total_bytes,
    );
    file.flush()?;
    drop(file);

    emit_download_progress(model, "verifying", 90, Some(downloaded_bytes), total_bytes);
    verify_sha256(&partial_path, &model.sha256)
        .with_context(|| format!("Failed to verify downloaded model {}", model.id))?;

    if model.is_directory {
        emit_download_progress(model, "extracting", 95, Some(downloaded_bytes), total_bytes);
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

    emit_download_progress(model, "ready", 100, Some(downloaded_bytes), total_bytes);
    Ok(())
}

fn emit_download_progress(
    model: &ModelInfo,
    stage: &str,
    progress: u8,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let event = DownloadProgressEvent {
        model: &model.id,
        stage,
        progress,
        downloaded_bytes,
        total_bytes,
    };

    if let Ok(json) = serde_json::to_string(&event) {
        eprintln!("{DOWNLOAD_PROGRESS_PREFIX}{json}");
    }
}

fn emit_transcription_progress(stage: &str, progress: u8) {
    let event = TranscriptionProgressEvent { stage, progress };

    if let Ok(json) = serde_json::to_string(&event) {
        eprintln!("{TRANSCRIPTION_PROGRESS_PREFIX}{json}");
    }
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
    diarization_enabled: bool,
) -> Result<TranscribeRunOutput> {
    emit_transcription_progress("loading audio", 10);
    let audio = read_audio_as_f32(input)?;
    let model_path = models_dir.join(&model.filename);

    emit_transcription_progress("transcribing audio", 20);
    let mut checkpoint_dir = None;
    let result = match model.engine_type {
        #[cfg(windows)]
        EngineType::Whisper => {
            return Err(anyhow!(
                "Whisper is not available in the Windows sidecar build"
            ));
        }
        #[cfg(not(windows))]
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
            result
        }
        EngineType::Parakeet => {
            let mut engine = ParakeetModel::load(&model_path, &Quantization::Int8)
                .with_context(|| format!("Failed to load Parakeet model {}", model.id))?;
            let params = ParakeetParams {
                timestamp_granularity: Some(TimestampGranularity::Word),
                ..Default::default()
            };
            let output =
                transcribe_parakeet(&mut engine, &audio, &params, input, models_dir, &model.id)?;
            checkpoint_dir = output.checkpoint_dir;
            output.result
        }
    };

    let mut segments = transcript_segments(result.segments);
    let text = transcript_text_from_segments(&segments).unwrap_or(result.text);
    if diarization_enabled {
        emit_transcription_progress("diarizing speakers", 72);
        let audio_duration_secs = audio.len() as f32 / TARGET_SAMPLE_RATE as f32;
        if audio_duration_secs <= DIARIZATION_MAX_FULL_AUDIO_SECS {
            if let Err(error) = assign_speakers(models_dir, &audio, &mut segments) {
                eprintln!("Speaker diarization skipped: {error:#}");
            }
        } else {
            eprintln!(
                "Speaker diarization skipped: audio duration {audio_duration_secs:.1}s exceeds {DIARIZATION_MAX_FULL_AUDIO_SECS:.1}s full-audio limit"
            );
        }
    } else {
        eprintln!("Speaker diarization skipped: disabled by configuration");
    }
    emit_transcription_progress("finalizing transcript", 84);
    smooth_short_speaker_runs(&mut segments);
    let segments = merge_transcript_segments(segments);

    Ok(TranscribeRunOutput {
        transcript: TranscriptOutput {
            text,
            language: language.to_string(),
            segments,
        },
        checkpoint_dir,
    })
}

fn transcribe_parakeet_with_tail_rescue(
    engine: &mut ParakeetModel,
    audio: &[f32],
    params: &ParakeetParams,
    input: &Path,
) -> Result<transcribe_rs::TranscriptionResult> {
    let mut result = engine
        .transcribe_with(audio, params)
        .with_context(|| format!("Parakeet transcription failed for {}", input.display()))?;

    rescue_parakeet_tail(engine, audio, params, &mut result, input)?;
    Ok(result)
}

fn transcribe_parakeet(
    engine: &mut ParakeetModel,
    audio: &[f32],
    params: &ParakeetParams,
    input: &Path,
    models_dir: &Path,
    model_id: &str,
) -> Result<ParakeetRunOutput> {
    let audio_duration_secs = audio.len() as f32 / TARGET_SAMPLE_RATE as f32;
    if audio_duration_secs <= PARAKEET_CHUNKING_THRESHOLD_SECS {
        return Ok(ParakeetRunOutput {
            result: transcribe_parakeet_with_tail_rescue(engine, audio, params, input)?,
            checkpoint_dir: None,
        });
    }

    transcribe_parakeet_chunked(engine, audio, params, input, models_dir, model_id)
}

fn transcribe_parakeet_chunked(
    engine: &mut ParakeetModel,
    audio: &[f32],
    params: &ParakeetParams,
    input: &Path,
    models_dir: &Path,
    model_id: &str,
) -> Result<ParakeetRunOutput> {
    let primary_chunk_samples = seconds_to_samples(PARAKEET_CHUNK_SECS).max(1);
    let overlap_samples = seconds_to_samples(PARAKEET_CHUNK_OVERLAP_SECS);
    let total_chunks = audio.len().div_ceil(primary_chunk_samples).max(1);
    let checkpoint = ParakeetCheckpoint::prepare(
        models_dir,
        input,
        model_id,
        audio.len(),
        primary_chunk_samples,
        overlap_samples,
        total_chunks,
    )?;
    let mut chunk_results = Vec::with_capacity(total_chunks);

    eprintln!(
        "Parakeet chunked transcription: {:.1}s audio, {total_chunks} chunks of {:.1}s with {:.1}s overlap",
        audio.len() as f32 / TARGET_SAMPLE_RATE as f32,
        PARAKEET_CHUNK_SECS,
        PARAKEET_CHUNK_OVERLAP_SECS
    );

    for chunk_index in 0..total_chunks {
        let chunk_number = chunk_index + 1;
        let chunk_start_progress = parakeet_chunk_progress(chunk_index, total_chunks);
        let chunk_stage = format!("transcribing chunk {chunk_number} of {total_chunks}");
        emit_transcription_progress(&chunk_stage, chunk_start_progress);

        if let Some(cached_chunk) = checkpoint.read_chunk(chunk_index)? {
            eprintln!("Parakeet checkpoint: loaded chunk {chunk_number} of {total_chunks}");
            chunk_results.push(cached_chunk.into_transcription_result());
            let progress = parakeet_chunk_progress(chunk_number, total_chunks);
            emit_transcription_progress(&chunk_stage, progress);
            continue;
        }

        let primary_start = chunk_index * primary_chunk_samples;
        if primary_start >= audio.len() {
            break;
        }

        let primary_end = ((chunk_index + 1) * primary_chunk_samples).min(audio.len());
        let slice_start = if chunk_index == 0 {
            0
        } else {
            primary_start.saturating_sub(overlap_samples)
        };
        let slice_end = if primary_end >= audio.len() {
            audio.len()
        } else {
            (primary_end + overlap_samples).min(audio.len())
        };

        let mut chunk_result = transcribe_parakeet_with_tail_rescue(
            engine,
            &audio[slice_start..slice_end],
            params,
            input,
        )
        .with_context(|| {
            format!(
                "Parakeet chunk {} of {} failed for {}",
                chunk_number,
                total_chunks,
                input.display()
            )
        })?;
        chunk_result.offset_timestamps(samples_to_seconds(slice_start));

        let filtered_segments = chunk_result
            .segments
            .take()
            .unwrap_or_default()
            .into_iter()
            .filter(|segment| {
                segment_belongs_to_primary_window(segment, primary_start, primary_end)
            })
            .collect::<Vec<_>>();
        let text = transcription_text_from_segments(Some(&filtered_segments)).unwrap_or_default();
        let chunk_checkpoint = ParakeetChunkCheckpoint::from_segments(
            chunk_index,
            total_chunks,
            text,
            filtered_segments,
        );
        checkpoint.write_chunk(&chunk_checkpoint)?;
        chunk_results.push(chunk_checkpoint.into_transcription_result());

        let progress = parakeet_chunk_progress(chunk_number, total_chunks);
        emit_transcription_progress(&chunk_stage, progress);
    }

    Ok(ParakeetRunOutput {
        result: merge_transcription_results(chunk_results),
        checkpoint_dir: Some(checkpoint.dir),
    })
}

fn parakeet_chunk_progress(completed_chunks: usize, total_chunks: usize) -> u8 {
    20 + ((completed_chunks as f32 / total_chunks.max(1) as f32) * 50.0)
        .round()
        .clamp(0.0, 50.0) as u8
}

impl ParakeetCheckpoint {
    fn prepare(
        models_dir: &Path,
        input: &Path,
        model_id: &str,
        audio_samples: usize,
        primary_chunk_samples: usize,
        overlap_samples: usize,
        total_chunks: usize,
    ) -> Result<Self> {
        let metadata = fs::metadata(input)
            .with_context(|| format!("Failed to stat input audio {}", input.display()))?;
        let input_path = input
            .canonicalize()
            .unwrap_or_else(|_| input.to_path_buf())
            .to_string_lossy()
            .to_string();
        let manifest = ParakeetCheckpointManifest {
            version: PARAKEET_CHECKPOINT_VERSION,
            input_path,
            input_size: metadata.len(),
            input_modified_unix_nanos: modified_unix_nanos(&metadata),
            model_id: model_id.to_string(),
            sample_rate: TARGET_SAMPLE_RATE,
            audio_samples,
            primary_chunk_samples,
            overlap_samples,
            total_chunks,
        };
        let dir = transcription_checkpoint_root(models_dir).join(checkpoint_key(&manifest));
        let manifest_path = dir.join("manifest.json");

        if dir.exists() {
            let should_reset = match read_json_file::<ParakeetCheckpointManifest>(&manifest_path) {
                Ok(existing) => existing != manifest,
                Err(_) => true,
            };

            if should_reset {
                fs::remove_dir_all(&dir).with_context(|| {
                    format!("Failed to reset transcription checkpoint {}", dir.display())
                })?;
            }
        }

        fs::create_dir_all(&dir).with_context(|| {
            format!(
                "Failed to create transcription checkpoint directory {}",
                dir.display()
            )
        })?;
        if !manifest_path.exists() {
            write_json_file_atomic(&manifest_path, &manifest)?;
        }

        Ok(Self { dir, manifest })
    }

    fn chunk_path(&self, chunk_index: usize) -> PathBuf {
        self.dir.join(format!("chunk-{chunk_index:05}.json"))
    }

    fn read_chunk(&self, chunk_index: usize) -> Result<Option<ParakeetChunkCheckpoint>> {
        let path = self.chunk_path(chunk_index);
        let chunk = match read_json_file::<ParakeetChunkCheckpoint>(&path) {
            Ok(chunk) => chunk,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io_error| io_error.kind() == ErrorKind::NotFound) =>
            {
                return Ok(None)
            }
            Err(error) => {
                eprintln!(
                    "Ignoring invalid transcription checkpoint chunk {}: {error:#}",
                    path.display()
                );
                let _ = fs::remove_file(&path);
                return Ok(None);
            }
        };

        if chunk.version != PARAKEET_CHECKPOINT_VERSION
            || chunk.chunk_index != chunk_index
            || chunk.total_chunks != self.manifest.total_chunks
        {
            eprintln!(
                "Ignoring mismatched transcription checkpoint chunk {}",
                path.display()
            );
            let _ = fs::remove_file(&path);
            return Ok(None);
        }

        Ok(Some(chunk))
    }

    fn write_chunk(&self, chunk: &ParakeetChunkCheckpoint) -> Result<()> {
        write_json_file_atomic(&self.chunk_path(chunk.chunk_index), chunk)
    }
}

impl ParakeetChunkCheckpoint {
    fn from_segments(
        chunk_index: usize,
        total_chunks: usize,
        text: String,
        segments: Vec<transcribe_rs::TranscriptionSegment>,
    ) -> Self {
        Self {
            version: PARAKEET_CHECKPOINT_VERSION,
            chunk_index,
            total_chunks,
            text,
            segments: segments
                .into_iter()
                .map(|segment| CheckpointSegment {
                    start: segment.start,
                    end: segment.end,
                    text: segment.text,
                })
                .collect(),
        }
    }

    fn into_transcription_result(self) -> transcribe_rs::TranscriptionResult {
        let segments = self
            .segments
            .into_iter()
            .map(|segment| transcribe_rs::TranscriptionSegment {
                start: segment.start,
                end: segment.end,
                text: segment.text,
            })
            .collect::<Vec<_>>();

        transcribe_rs::TranscriptionResult {
            text: self.text,
            segments: if segments.is_empty() {
                None
            } else {
                Some(segments)
            },
        }
    }
}

fn transcription_checkpoint_root(models_dir: &Path) -> PathBuf {
    models_dir
        .parent()
        .unwrap_or(models_dir)
        .join("cache")
        .join("transcription-runs")
}

fn checkpoint_key(manifest: &ParakeetCheckpointManifest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"parakeet-checkpoint-v1\0");
    hasher.update(manifest.input_path.as_bytes());
    hasher.update(manifest.input_size.to_le_bytes());
    hasher.update(manifest.input_modified_unix_nanos.as_bytes());
    hasher.update(manifest.model_id.as_bytes());
    hasher.update(manifest.sample_rate.to_le_bytes());
    hasher.update(manifest.audio_samples.to_le_bytes());
    hasher.update(manifest.primary_chunk_samples.to_le_bytes());
    hasher.update(manifest.overlap_samples.to_le_bytes());
    hasher.update(manifest.total_chunks.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn modified_unix_nanos(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "0".to_string())
}

fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path)?;
    serde_json::from_reader(file).with_context(|| format!("Failed to parse {}", path.display()))
}

fn write_json_file_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("Failed to create directory {}", parent.display()))?;

    let tmp_path = path.with_extension("json.tmp");
    {
        let mut file = File::create(&tmp_path)
            .with_context(|| format!("Failed to create {}", tmp_path.display()))?;
        let json = serde_json::to_vec_pretty(value)?;
        file.write_all(&json)
            .with_context(|| format!("Failed to write {}", tmp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("Failed to sync {}", tmp_path.display()))?;
    }

    if path.exists() {
        fs::remove_file(path).with_context(|| format!("Failed to replace {}", path.display()))?;
    }
    fs::rename(&tmp_path, path).with_context(|| {
        format!(
            "Failed to move {} to {}",
            tmp_path.display(),
            path.display()
        )
    })?;

    Ok(())
}

fn seconds_to_samples(seconds: f32) -> usize {
    (seconds * TARGET_SAMPLE_RATE as f32).round().max(0.0) as usize
}

fn samples_to_seconds(samples: usize) -> f32 {
    samples as f32 / TARGET_SAMPLE_RATE as f32
}

fn segment_belongs_to_primary_window(
    segment: &transcribe_rs::TranscriptionSegment,
    primary_start_samples: usize,
    primary_end_samples: usize,
) -> bool {
    if segment.text.trim().is_empty() {
        return false;
    }

    let primary_start = samples_to_seconds(primary_start_samples);
    let primary_end = samples_to_seconds(primary_end_samples);
    let midpoint = (segment.start + segment.end) / 2.0;

    midpoint >= primary_start && midpoint < primary_end
}

fn merge_transcription_results(
    results: Vec<transcribe_rs::TranscriptionResult>,
) -> transcribe_rs::TranscriptionResult {
    let text = results
        .iter()
        .map(|result| result.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let segments = results
        .into_iter()
        .filter_map(|result| result.segments)
        .flatten()
        .collect::<Vec<_>>();

    transcribe_rs::TranscriptionResult {
        text,
        segments: if segments.is_empty() {
            None
        } else {
            Some(segments)
        },
    }
}

fn rescue_parakeet_tail(
    engine: &mut ParakeetModel,
    audio: &[f32],
    params: &ParakeetParams,
    result: &mut transcribe_rs::TranscriptionResult,
    input: &Path,
) -> Result<()> {
    let Some(last_end) = last_segment_end(result.segments.as_deref()) else {
        return Ok(());
    };

    let audio_duration = audio.len() as f32 / TARGET_SAMPLE_RATE as f32;
    if audio_duration - last_end <= TRANSCRIPTION_TAIL_GAP_SECS {
        return Ok(());
    }

    let untranscribed_start_sample = ((last_end + TRANSCRIPTION_TAIL_WORD_GRACE_SECS)
        * TARGET_SAMPLE_RATE as f32)
        .floor() as usize;
    let untranscribed_tail = audio.get(untranscribed_start_sample..).unwrap_or_default();
    if rms(untranscribed_tail) < MIN_TAIL_RETRY_RMS {
        return Ok(());
    }

    let tail_start = (last_end - TRANSCRIPTION_TAIL_CONTEXT_SECS).max(0.0);
    let tail_start_sample = (tail_start * TARGET_SAMPLE_RATE as f32).floor() as usize;
    let tail_audio = audio.get(tail_start_sample..).unwrap_or_default();
    if tail_audio.len() as f32 / TARGET_SAMPLE_RATE as f32 <= MIN_TAIL_RETRY_SECS {
        return Ok(());
    }

    eprintln!(
        "Parakeet tail rescue: final segment ended at {last_end:.2}s of {audio_duration:.2}s; retrying from {tail_start:.2}s"
    );

    let tail_params = ParakeetParams {
        timestamp_granularity: Some(TimestampGranularity::Word),
        ..params.clone()
    };
    let mut tail_result = engine
        .transcribe_with(tail_audio, &tail_params)
        .with_context(|| format!("Parakeet tail transcription failed for {}", input.display()))?;
    tail_result.offset_timestamps(tail_start);

    let Some(tail_segment) = build_tail_segment_after(
        tail_result.segments.unwrap_or_default(),
        last_end - TRANSCRIPTION_TAIL_WORD_GRACE_SECS,
    ) else {
        return Ok(());
    };

    result
        .segments
        .get_or_insert_with(Vec::new)
        .push(tail_segment);

    if let Some(text) = transcription_text_from_segments(result.segments.as_deref()) {
        result.text = text;
    }

    Ok(())
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let mean_square = samples
        .iter()
        .map(|sample| {
            let sample = *sample as f64;
            sample * sample
        })
        .sum::<f64>()
        / samples.len() as f64;

    mean_square.sqrt() as f32
}

fn last_segment_end(segments: Option<&[transcribe_rs::TranscriptionSegment]>) -> Option<f32> {
    segments?
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .map(|segment| segment.end)
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

fn build_tail_segment_after(
    segments: Vec<transcribe_rs::TranscriptionSegment>,
    start_after: f32,
) -> Option<transcribe_rs::TranscriptionSegment> {
    let words = segments
        .into_iter()
        .filter(|segment| segment.start >= start_after && !segment.text.trim().is_empty())
        .collect::<Vec<_>>();

    let first = words.first()?;
    let last = words.last()?;
    let text = words
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if text.is_empty() {
        return None;
    }

    Some(transcribe_rs::TranscriptionSegment {
        start: first.start,
        end: last.end,
        text,
    })
}

fn transcription_text_from_segments(
    segments: Option<&[transcribe_rs::TranscriptionSegment]>,
) -> Option<String> {
    let text = segments?
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn transcript_segments(
    segments: Option<Vec<transcribe_rs::TranscriptionSegment>>,
) -> Vec<TranscriptSegment> {
    segments
        .unwrap_or_default()
        .into_iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .map(|segment| TranscriptSegment {
            text: segment.text.trim().to_string(),
            start: Some(segment.start as f64),
            end: Some(segment.end as f64),
            speaker: None,
        })
        .collect()
}

fn transcript_text_from_segments(segments: &[TranscriptSegment]) -> Option<String> {
    let text = segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn merge_transcript_segments(segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    let mut merged = Vec::new();
    let mut current: Option<TranscriptSegment> = None;

    for segment in segments {
        let Some(active) = current.as_mut() else {
            current = Some(segment);
            continue;
        };

        if can_merge_transcript_segments(active, &segment) {
            append_transcript_text(&mut active.text, &segment.text);
            active.end = segment.end.or(active.end);
        } else {
            if let Some(previous) = current.replace(segment) {
                merged.push(previous);
            }
        }
    }

    if let Some(segment) = current {
        merged.push(segment);
    }

    merged
}

fn smooth_short_speaker_runs(segments: &mut [TranscriptSegment]) {
    if segments.len() < 3 {
        return;
    }

    let mut runs = Vec::new();
    let mut start = 0;
    while start < segments.len() {
        let speaker = segments[start].speaker.clone();
        let mut end = start + 1;
        while end < segments.len() && segments[end].speaker == speaker {
            end += 1;
        }
        runs.push((start, end, speaker));
        start = end;
    }

    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    for index in 1..runs.len().saturating_sub(1) {
        let (start, end, speaker) = &runs[index];
        let Some(previous_speaker) = runs[index - 1].2.as_ref() else {
            continue;
        };
        let Some(next_speaker) = runs[index + 1].2.as_ref() else {
            continue;
        };
        if previous_speaker != next_speaker {
            continue;
        }

        let duration = run_duration(&segments[*start..*end]);
        let word_count = segments[*start..*end]
            .iter()
            .map(|segment| count_words(&segment.text))
            .sum::<usize>();
        let is_short_run =
            duration <= SHORT_SPEAKER_RUN_MAX_SECS && word_count <= SHORT_SPEAKER_RUN_MAX_WORDS;

        if speaker.is_none() || is_short_run {
            replacements.push((*start, *end, previous_speaker.clone()));
        }
    }

    for (start, end, speaker) in replacements {
        for segment in &mut segments[start..end] {
            segment.speaker = Some(speaker.clone());
        }
    }
}

fn run_duration(segments: &[TranscriptSegment]) -> f64 {
    let Some(first) = segments.first() else {
        return 0.0;
    };
    let Some(last) = segments.last() else {
        return 0.0;
    };
    let start = first.start.unwrap_or(0.0);
    let end = last.end.or(last.start).unwrap_or(start);
    (end - start).max(0.0)
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn can_merge_transcript_segments(left: &TranscriptSegment, right: &TranscriptSegment) -> bool {
    if left.speaker != right.speaker {
        return false;
    }

    let left_end = left.end.or(left.start).unwrap_or(0.0);
    let right_start = right.start.unwrap_or(left_end);
    if right_start - left_end > TRANSCRIPT_SEGMENT_MERGE_GAP_SECS {
        return false;
    }

    let merged_start = left.start.unwrap_or(right_start);
    let merged_end = right.end.or(right.start).unwrap_or(left_end);
    if merged_end - merged_start > TRANSCRIPT_SEGMENT_MAX_SECS {
        return false;
    }

    left.text.len() + right.text.len() + 1 <= TRANSCRIPT_SEGMENT_MAX_CHARS
}

fn append_transcript_text(target: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if target.is_empty() {
        target.push_str(next);
        return;
    }

    if next
        .chars()
        .next()
        .map(|ch| matches!(ch, '.' | ',' | '!' | '?' | ';' | ':' | ')' | ']' | '}'))
        .unwrap_or(false)
    {
        target.push_str(next);
    } else {
        target.push(' ');
        target.push_str(next);
    }
}

fn assign_speakers(
    models_dir: &Path,
    audio: &[f32],
    segments: &mut [TranscriptSegment],
) -> Result<()> {
    if audio.is_empty() || segments.is_empty() {
        return Ok(());
    }

    let registry = ModelRegistry::with_cache_dir(models_dir.join("diarization"))
        .context("Failed to initialize diarization model registry")?;
    let models = registry
        .ensure_for_profile(Profile::Balanced)
        .context("Failed to prepare diarization models")?;

    let segmenter = PowersetSegmenter::new(&models.segmenter_path)
        .context("Failed to load diarization segmentation model")?;
    let embedder = ResNet34Adapter::new(&models.embedder_path, 1)
        .context("Failed to load diarization embedding model")?;
    let clusterer = KMeansClusterer::new(20);
    let pipeline = HybridPipeline::new(
        Box::new(segmenter),
        Box::new(SerialEmbedder::new(embedder)),
        Box::new(clusterer),
    );
    let sample_rate = SampleRate::new(TARGET_SAMPLE_RATE)
        .ok_or_else(|| anyhow!("Unsupported diarization sample rate: {TARGET_SAMPLE_RATE}"))?;
    let diarization = pipeline
        .run(audio, sample_rate)
        .context("Speaker diarization failed")?;

    for segment in segments {
        segment.speaker = best_speaker_for_segment(segment, &diarization.turns);
    }

    Ok(())
}

fn best_speaker_for_segment(segment: &TranscriptSegment, turns: &[SpeakerTurn]) -> Option<String> {
    let start = segment.start?;
    let end = segment.end.unwrap_or(start);
    if end <= start {
        return None;
    }

    let mut best_speaker = None;
    let mut best_overlap = 0.0_f64;

    for turn in turns {
        let overlap_start = start.max(turn.time.start);
        let overlap_end = end.min(turn.time.end);
        let overlap = (overlap_end - overlap_start).max(0.0);

        if overlap > best_overlap {
            best_overlap = overlap;
            best_speaker = Some(turn.speaker);
        }
    }

    best_speaker
        .filter(|_| best_overlap > 0.0)
        .map(|speaker| format!("Speaker {}", speaker.0 + 1))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn unique_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "recorder-transcriber-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn parakeet_checkpoint_round_trips_completed_chunk() {
        let root = unique_test_dir("checkpoint-round-trip");
        let models_dir = root.join("models");
        let input = root.join("recording.mock");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&input, b"audio").expect("write input");

        let checkpoint =
            ParakeetCheckpoint::prepare(&models_dir, &input, "parakeet-v3", 32_000, 16_000, 320, 2)
                .expect("prepare checkpoint");

        let chunk = ParakeetChunkCheckpoint::from_segments(
            0,
            2,
            "hello world".to_string(),
            vec![transcribe_rs::TranscriptionSegment {
                start: 0.0,
                end: 1.0,
                text: "hello world".to_string(),
            }],
        );
        checkpoint.write_chunk(&chunk).expect("write chunk");

        let resumed =
            ParakeetCheckpoint::prepare(&models_dir, &input, "parakeet-v3", 32_000, 16_000, 320, 2)
                .expect("prepare resumed checkpoint");
        let cached = resumed
            .read_chunk(0)
            .expect("read chunk")
            .expect("cached chunk");
        let result = cached.into_transcription_result();

        assert_eq!(result.text, "hello world");
        assert_eq!(result.segments.expect("segments").len(), 1);

        fs::remove_dir_all(&root).expect("remove test root");
    }
}
