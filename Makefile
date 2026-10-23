IMAGE ?= agentcore-doom
CONTAINER ?= agentcore-doom
AGENT_PORT ?= 8080
WEBUI_PORT ?= 3000
ARN_FILE ?= $(CURDIR)/tmp/doom_runtime_arn.txt
TF := cd terraform && terraform

deploy:
	cd webui && npm ci --omit=dev
	$(TF) init
	$(TF) apply --auto-approve

destroy: 
	$(TF) destroy --auto-approve

doom-build:
	docker build --platform linux/arm64 -t $(IMAGE) doom/

doom-run: doom-stop
	docker run -d --rm --name $(CONTAINER) -p $(AGENT_PORT):8080 $(IMAGE)

doom-stop:
	-docker rm -f $(CONTAINER) 2>/dev/null

doom-logs:
	docker logs -f $(CONTAINER)

webui-install:
	cd webui && npm install

webui-run:
	cd webui && LOCAL_AGENT_URL=http://localhost:$(AGENT_PORT) PORT=$(WEBUI_PORT) npm start

# Local web UI signing requests to the deployed runtime (SigV4 with your local AWS credentials).
# Terraform writes the runtime ARN to $(ARN_FILE).
webui-run-acr:
	$(eval AGENT_RUNTIME_ARN := $(shell cat $(ARN_FILE)))
	cd webui && AGENT_RUNTIME_ARN=$(AGENT_RUNTIME_ARN) PORT=$(WEBUI_PORT) npm start

local: doom-build doom-run webui-install webui-run
