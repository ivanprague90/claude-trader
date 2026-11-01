#!/bin/bash
# Bootstrap dell'istanza EC2 (Ubuntu 24.04). Lo esegue cloud-init UNA volta, come root, al primo avvio.
# Installa Docker + Compose, l'AWS CLI e clona il repository in /opt/claude-trader.
# Non contiene nessuna chiave: le chiavi si prendono dopo, da SSM Parameter Store (deploy/aws/fetch-env.sh).
#
# REPO_BRANCH viene sostituito dal comando di lancio descritto in docs/DEPLOY-AWS.md.
set -euxo pipefail
exec > >(tee -a /var/log/claude-trader-bootstrap.log) 2>&1

REPO_URL="https://github.com/ivanprague90/claude-trader"
REPO_BRANCH="main"
APP_DIR="/opt/claude-trader"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git unzip docker.io docker-compose-v2
systemctl enable --now docker
usermod -aG docker ubuntu

# AWS CLI v2: serve a fetch-env.sh per leggere i segreti da SSM Parameter Store
if ! command -v aws >/dev/null 2>&1; then
  cd /tmp
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
  unzip -q awscliv2.zip
  ./aws/install
  rm -rf aws awscliv2.zip
fi

git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR"

# segnale per chi aspetta: il bootstrap è finito
touch /var/lib/claude-trader-bootstrap-done
