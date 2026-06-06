ELECTRON_DIR := apps/electron

.PHONY: help install dev build test typecheck clean

help:
	@echo "HiDock Local targets:"
	@echo "  make install    Install Electron app dependencies"
	@echo "  make dev        Run the Electron app in development mode"
	@echo "  make build      Build the Electron app"
	@echo "  make test       Run Electron app tests"
	@echo "  make typecheck  Run Electron app type checks"
	@echo "  make clean      Remove Electron build outputs"

install:
	cd $(ELECTRON_DIR) && npm install

dev:
	cd $(ELECTRON_DIR) && npm run dev

build:
	cd $(ELECTRON_DIR) && npm run build

test:
	cd $(ELECTRON_DIR) && npm run test:run

typecheck:
	cd $(ELECTRON_DIR) && npm run typecheck

clean:
	rm -rf $(ELECTRON_DIR)/out $(ELECTRON_DIR)/dist $(ELECTRON_DIR)/coverage
