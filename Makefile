ELECTRON_DIR := apps/electron

.PHONY: help install dev transcriber build test typecheck clean

help:
	@echo "Local Recorder targets:"
	@echo "  make install    Install Electron app dependencies"
	@echo "  make dev        Run the Electron app in development mode"
	@echo "  make transcriber Build the local transcription sidecar"
	@echo "  make build      Build the Electron app"
	@echo "  make test       Run Electron app tests"
	@echo "  make typecheck  Run Electron app type checks"
	@echo "  make clean      Remove Electron build outputs"

install:
	cd $(ELECTRON_DIR) && npm install

dev:
	cd $(ELECTRON_DIR) && npm run dev

transcriber:
	cd $(ELECTRON_DIR) && npm run build:transcriber

build:
	cd $(ELECTRON_DIR) && npm run build:transcriber && npm run build

test:
	cd $(ELECTRON_DIR) && npm run test:run

typecheck:
	cd $(ELECTRON_DIR) && npm run typecheck

clean:
	rm -rf $(ELECTRON_DIR)/out $(ELECTRON_DIR)/dist $(ELECTRON_DIR)/coverage $(ELECTRON_DIR)/native/transcriber/target
