#!/usr/bin/env bash
# Genera .env (chmod 600) leggendo i segreti da SSM Parameter Store (SecureString) sotto /claude-trader/.
# Si lancia sul server, dalla cartella del repo:   ./deploy/aws/fetch-env.sh
# Usa il ruolo IAM dell'istanza: nessuna chiave AWS sul server. Stampa solo i NOMI delle variabili, mai i valori.
#
# Variabili opzionali:  PARAM_PREFIX (default /claude-trader)   AWS_REGION (default: quella dell'istanza)
set -euo pipefail

cd "$(dirname "$0")/../.."
PREFIX="${PARAM_PREFIX:-/claude-trader}"

REGION="${AWS_REGION:-}"
if [ -z "$REGION" ]; then
  # metadati dell'istanza, IMDSv2 (il token è obbligatorio)
  TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
fi

umask 077
tmp="$(mktemp .env.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text \
  | while IFS=$'\t' read -r name value; do
      printf '%s=%s\n' "${name##*/}" "$value"
    done > "$tmp"

if [ ! -s "$tmp" ]; then
  echo "Nessun parametro trovato sotto $PREFIX (regione $REGION)." >&2
  exit 1
fi

mv "$tmp" .env
chmod 600 .env
echo "Scritto .env con: $(cut -d= -f1 .env | tr '\n' ' ')"
