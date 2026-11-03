# Mettere claude-trader su AWS (EC2 + Docker), tutto da AWS CLI

Guida passo passo: installare gli strumenti, creare il server, avviare il trader, aggiornarlo, fare backup, monitorarlo e cancellare tutto.

**Cosa costruisci**

```
tuo computer ──(AWS CLI)──▶  AWS
                              ├─ SSM Parameter Store   le chiavi (SecureString, cifrate)
                              ├─ IAM role              permesso di leggere SOLO /claude-trader/*
                              └─ EC2 t3.small  (Ubuntu 24.04, disco da 20 GB cifrato)
                                   └─ Docker: container "claude-trader"  →  bun run schedule
                                        ├─ volume trader-state   testimone, lucchetto, storia
                                        └─ volume trader-logs    un log per sveglia
```

- **Nessuna porta aperta.** Il trader fa solo chiamate in uscita (Alpaca, Telegram, Claude). Il security group non ha nessuna regola in ingresso e ci si collega con **SSM Session Manager** invece che con SSH: niente chiavi `.pem`, niente porta 22.
- **Nessuna chiave sul tuo disco o in git.** Le chiavi stanno in SSM Parameter Store; sul server vengono scritte in `.env` (permessi 600) solo per far partire Docker.
- Il codice usa l'ora di Roma in modo esplicito: il fuso del server non conta.

> **Windows:** i comandi sono per **bash**. Usa **Git Bash** o **WSL**, non PowerShell/cmd (PowerShell serve solo per installare gli strumenti, punto 1). In Git Bash il blocco di variabili qui sotto imposta `MSYS_NO_PATHCONV=1`: senza, Git Bash trasforma i nomi che iniziano con `/` (come `/claude-trader/...`) in percorsi Windows e AWS risponde con errori strani.

> **Soldi:** pagherai EC2, il disco EBS e l'IPv4 pubblico dell'istanza (AWS fa pagare anche quello). Non crei NAT gateway né load balancer. Per le cifre aggiornate usa il [calcolatore prezzi AWS](https://calculator.aws/). Metti un budget alarm (punto 10).

---

## Indice

1. [Installare e configurare gli strumenti](#1-installare-e-configurare-gli-strumenti)
2. [Variabili comuni](#2-variabili-comuni)
3. [Salvare le chiavi in Parameter Store](#3-salvare-le-chiavi-in-parameter-store)
4. [Ruolo IAM e rete](#4-ruolo-iam-e-rete)
5. [Creare l'istanza](#5-creare-listanza)
6. [Primo avvio del trader](#6-primo-avvio-del-trader)
7. [Uso quotidiano](#7-uso-quotidiano)
8. [Aggiornare](#8-aggiornare)
9. [Backup e ripristino](#9-backup-e-ripristino)
10. [Monitoraggio e budget](#10-monitoraggio-e-budget)
11. [Fermare, riavviare, cancellare tutto](#11-fermare-riavviare-cancellare-tutto)
12. [Problemi comuni](#12-problemi-comuni)

---

## 1. Installare e configurare gli strumenti

### 1.1 AWS CLI v2

**macOS**

```bash
brew install awscli
# oppure il pacchetto ufficiale:
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /
```

**Linux (x86_64)**

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

**Windows (PowerShell, come amministratore)**

```powershell
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi
# oppure: winget install Amazon.AWSCLI
```

Chiudi e riapri il terminale, poi:

```bash
aws --version     # deve stampare aws-cli/2.x.x
```

Altri metodi e aggiornamenti: <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>

### 1.2 Plugin Session Manager (per collegarti al server senza SSH)

**macOS**

```bash
brew install --cask session-manager-plugin
```

**Ubuntu / Debian**

```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o session-manager-plugin.deb
sudo dpkg -i session-manager-plugin.deb
```

**Windows**: scarica ed esegui l'installer
<https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe>

Verifica (serve la versione 1.2.764.0 o successiva):

```bash
session-manager-plugin --version
```

Se un link non funziona, le istruzioni aggiornate per ogni sistema sono qui:
<https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html>

### 1.3 Utente IAM dedicato al deploy

Non usare le chiavi dell'utente root. Crea un utente IAM **solo per questo progetto**, con i permessi minimi che servono ai comandi di questa guida (`deploy/aws/deployer-policy.json`): EC2 nella regione scelta, IAM limitato al solo ruolo `claude-trader`, i parametri `/claude-trader*` di Parameter Store, Session Manager, e (facoltativi) allarme CloudWatch e budget.

La prima volta serve un'identità che possa creare utenti IAM (root o un amministratore): è l'unico momento in cui ti serve.

**Strada A, dalla console AWS**

1. IAM → *Policies* → *Create policy* → scheda *JSON*: incolla il contenuto di `deploy/aws/deployer-policy.json`, **dopo aver sostituito** `ACCOUNT_ID` con l'ID del tuo account (12 cifre, in alto a destra nella console) e, se non usi Francoforte, `eu-central-1` con la tua regione. Nome: `claude-trader-deploy`.
2. IAM → *Users* → *Create user*: nome `claude-trader-deployer`, **senza** accesso alla console. In *Permissions* scegli *Attach policies directly* e seleziona `claude-trader-deploy`.
3. Apri l'utente → *Security credentials* → *Create access key* → caso d'uso *Command Line Interface (CLI)*. Copia *Access key ID* e *Secret access key* (la secret si vede una volta sola).
4. Consigliato: nella stessa pagina, *Assign MFA device*.

**Strada B, da AWS CLI** (se hai già un profilo amministratore, per esempio `--profile admin`):

```bash
export MSYS_NO_PATHCONV=1 AWS_PAGER="" AWS_REGION=eu-central-1     # vedi punto 2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)    # con il profilo amministratore attivo

# la policy, con account e regione al posto dei segnaposto
POLICY=$(sed -e "s/ACCOUNT_ID/$ACCOUNT_ID/g" -e "s/eu-central-1/$AWS_REGION/g" deploy/aws/deployer-policy.json)

aws iam create-policy --policy-name claude-trader-deploy --policy-document "$POLICY" --query Policy.Arn --output text
aws iam create-user --user-name claude-trader-deployer
aws iam attach-user-policy --user-name claude-trader-deployer \
  --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/claude-trader-deploy"
aws iam create-access-key --user-name claude-trader-deployer \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
```

L'ultimo comando stampa le due chiavi **una volta sola**: copiale subito. La policy è gestita e non inline perché supera il limite di 2048 caratteri delle policy inline degli utenti.

**Creare il profilo sul tuo computer** (in entrambi i casi):

```bash
aws configure --profile claude-trader-deployer
#   AWS Access Key ID:      <la chiave>
#   AWS Secret Access Key:  <la secret>
#   Default region name:    eu-central-1
#   Default output format:  json

export AWS_PROFILE=claude-trader-deployer         # PowerShell: $env:AWS_PROFILE="claude-trader-deployer"
aws sts get-caller-identity                       # deve mostrare .../user/claude-trader-deployer
```

D'ora in poi tutti i comandi della guida usano questo profilo. `AWS_PROFILE` vale solo per il terminale in cui lo imposti: riesportalo a ogni nuova sessione (è nel blocco del punto 2).

Cose da sapere:

- **Se un comando dà `AccessDenied`**, l'errore nomina l'azione mancante (per esempio `kms:CreateGrant` se il disco cifrato lo richiede): aggiungila a una nuova versione della policy.
- **Questo utente può dare permessi al ruolo `claude-trader`** (può scrivere la policy del ruolo), quindi in pratica può ottenerne di più di quelli elencati. Trattalo come sensibile: MFA, chiavi mai in git né in chat, e disattivale quando non servono (`aws iam update-access-key --user-name claude-trader-deployer --access-key-id <id> --status Inactive`).
- **Per cancellarlo** a fine progetto: `aws iam delete-access-key`, `aws iam detach-user-policy`, `aws iam delete-user`, `aws iam delete-policy` (con un profilo amministratore).

### 1.4 Strumenti sul tuo computer per il trader

`claude setup-token` serve a creare il token che userà il server (punto 3). Richiede Claude Code installato e già loggato sul tuo computer: <https://claude.com/claude-code>.

---

## 2. Variabili comuni

Esegui questo blocco **all'inizio di ogni sessione** di terminale (le variabili non sopravvivono alla chiusura). Poi, dalla cartella del repo `claude-trader`.

```bash
export MSYS_NO_PATHCONV=1            # solo Git Bash su Windows: vedi nota in alto. Innocuo altrove
export AWS_PAGER=""                  # niente pager interattivo
export AWS_PROFILE=claude-trader-deployer   # l'utente IAM del punto 1.3
export AWS_REGION=eu-central-1       # Francoforte. Milano (eu-south-1) va prima abilitata in Account → AWS Regions
NAME=claude-trader
INSTANCE_TYPE=t3.small               # 2 GB di RAM: claude -p è un processo Node, 1 GB è troppo stretto
REPO_BRANCH=initial-implementation   # il branch da clonare sul server. Dopo il merge in main: main
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT_ID · regione $AWS_REGION"
```

**Ritrovare le risorse già create** (per le sessioni successive: aggiornare, cancellare…):

```bash
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)
echo "istanza: $INSTANCE_ID · security group: $SG_ID"
```

---

## 3. Salvare le chiavi in Parameter Store

Le chiavi si inseriscono una volta dal tuo computer. `read -s` non mostra quello che scrivi e non lo salva nella cronologia.

Prima genera il token per Claude Code (si apre il browser per l'autorizzazione; copia il token che stampa):

```bash
claude setup-token
```

Poi salva le cinque chiavi:

```bash
put_secret() {
  local k="$1" v
  read -rsp "$k: " v; echo
  aws ssm put-parameter --name "/claude-trader/$k" --type SecureString --value "$v" --overwrite >/dev/null && echo "salvato $k"
}
for k in ALPACA_KEY_ID ALPACA_SECRET_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID CLAUDE_CODE_OAUTH_TOKEN; do
  put_secret "$k"
done
```

Dove le trovi:

| Chiave | Da dove |
|---|---|
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | app.alpaca.markets → **Paper Trading** → API Keys |
| `TELEGRAM_BOT_TOKEN` | `@BotFather` → `/newbot` |
| `TELEGRAM_CHAT_ID` | `https://api.telegram.org/bot<TOKEN>/getUpdates` → `"chat":{"id":` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` sul tuo computer |

Verifica (mostra solo i nomi, non i valori):

```bash
aws ssm get-parameters-by-path --path /claude-trader --query 'Parameters[].Name' --output text
```

> `CLAUDE_CODE_OAUTH_TOKEN` è la credenziale del tuo abbonamento Claude: trattala come una password. Non incollare nessuna di queste chiavi in chat, issue o commit.

---

## 4. Ruolo IAM e rete

### 4.1 Ruolo per l'istanza

Il ruolo permette due cose: farsi gestire da Session Manager e leggere **solo** i parametri `/claude-trader*`.

```bash
aws iam create-role --role-name $NAME \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query Role.Arn --output text

aws iam attach-role-policy --role-name $NAME \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam put-role-policy --role-name $NAME --policy-name read-claude-trader-params \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters","ssm:GetParametersByPath"],"Resource":"arn:aws:ssm:'"$AWS_REGION:$ACCOUNT_ID"':parameter/claude-trader*"}]}'

aws iam create-instance-profile --instance-profile-name $NAME
aws iam add-role-to-instance-profile --instance-profile-name $NAME --role-name $NAME
sleep 15     # IAM impiega qualche secondo a propagarsi
```

### 4.2 Security group senza ingresso

```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
echo "VPC: $VPC_ID"      # se stampa "None" non hai la VPC di default: aws ec2 create-default-vpc

SG_ID=$(aws ec2 create-security-group --group-name $NAME --vpc-id "$VPC_ID" \
  --description "claude-trader: nessun traffico in ingresso" --query GroupId --output text)
echo "security group: $SG_ID"
```

Un security group nuovo non ha regole in ingresso e lascia uscire tutto il traffico: è quello che serve.

---

## 5. Creare l'istanza

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)
echo "AMI Ubuntu 24.04: $AMI_ID"

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type $INSTANCE_TYPE \
  --iam-instance-profile Name=$NAME \
  --security-group-ids "$SG_ID" \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --credit-specification CpuCredits=standard \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "$(sed "s|^REPO_BRANCH=.*|REPO_BRANCH=\"$REPO_BRANCH\"|" deploy/aws/user-data.sh)" \
  --query 'Instances[0].InstanceId' --output text)
echo "istanza: $INSTANCE_ID"
```

Cosa fanno le opzioni meno ovvie:

- `HttpTokens=required`: metadati dell'istanza solo con IMDSv2.
- `CpuCredits=standard`: se un giorno il processo usasse la CPU senza sosta, l'istanza rallenta invece di farti pagare crediti extra.
- `Encrypted=true`: disco cifrato.
- `--user-data`: lo script `deploy/aws/user-data.sh` installa Docker, l'AWS CLI e clona il repository nel branch scelto.
- Se ricevi `Invalid IAM Instance Profile name`, il ruolo non si è ancora propagato: aspetta 20 secondi e ripeti.

Aspetta che sia pronta e controlla che Session Manager la veda:

```bash
aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text      # deve stampare: Online
```

Se stampa `None`, aspetta un minuto e riprova (l'agente SSM impiega un po' a registrarsi). Se resta `None`, vedi [Problemi comuni](#12-problemi-comuni).

---

## 6. Primo avvio del trader

### 6.1 Collegarsi al server

```bash
aws ssm start-session --target "$INSTANCE_ID"
```

Sei sul server come `ssm-user`. Passa all'utente `ubuntu` (quello che possiede il repo) e controlla che il bootstrap sia finito:

```bash
sudo -iu ubuntu
cloud-init status --wait             # deve finire con: status: done
ls /var/lib/claude-trader-bootstrap-done
```

### 6.2 Chiavi, build, prove

```bash
cd /opt/claude-trader
./deploy/aws/fetch-env.sh            # scrive .env da Parameter Store; stampa solo i nomi

docker compose build                 # la prima volta qualche minuto
docker compose run --rm trader bun test                              # tutti verdi, zero fail
docker compose run --rm trader bun src/cli.ts once --fake --slot 1540  # prova senza rete né chiavi
```

### 6.3 Accendere il trader

```bash
docker compose up -d
docker compose logs --tail 20
```

Devi leggere `[schedule ] acceso · controllo l'ora ogni 30 secondi · prossima sveglia ...`.

### 6.4 Prova vera con il briefing (non invia mai ordini)

```bash
docker compose exec trader bun src/cli.ts once --slot 0900 --force
```

Sul telefono devono arrivare un ▶️ e un ✅. Nel terminale la riga `[cervello ]` deve mostrare gli ordini proposti, senza errori.

Se qualcosa non va, vedi [Problemi comuni](#12-problemi-comuni).

### 6.5 Spegnere il trader sul tuo computer

Se avevi `bun run schedule` acceso sul laptop, **fermalo**: deve esserci un solo trader attivo.

Esci dal server con `exit` due volte (prima da `ubuntu`, poi dalla sessione).

---

## 7. Uso quotidiano

Collegati con `aws ssm start-session --target "$INSTANCE_ID"` e `sudo -iu ubuntu`, poi `cd /opt/claude-trader`.

| Cosa | Comando |
|---|---|
| Stato (lucchetto, ultimo testimone, prossima sveglia, conto) | `docker compose exec trader bun src/cli.ts status` |
| Log del processo, in diretta | `docker compose logs -f --tail 100` |
| Elenco dei log per sveglia | `docker compose exec trader ls logs` |
| Leggere il log di una sveglia | `docker compose exec trader cat logs/2026-11-02-1540.log` |
| Cosa è successo a una sveglia interrotta | `docker compose exec trader bun src/cli.ts reconcile` |
| Rifare una sveglia già fatta | `docker compose exec trader bun src/cli.ts once --slot 0900 --force` |
| Riavviare il trader | `docker compose restart` |
| Fermare il trader | `docker compose stop` |
| Riaccenderlo | `docker compose start` |

Un comando solo, senza aprire una sessione interattiva (dal tuo computer):

```bash
aws ssm start-session --target "$INSTANCE_ID" --document-name AWS-StartInteractiveCommand \
  --parameters command="cd /opt/claude-trader && sudo docker compose logs --tail 50"
```

Come capisci se funziona: ogni sveglia manda un ▶️ all'inizio e un ✅ alla fine. Se alle 09:00 non arriva il ▶️, il server o il trader sono fermi. Se arriva il ▶️ ma non il ✅, la sveglia è morta a metà: la successiva lo segnala e riconcilia con Alpaca.

---

## 8. Aggiornare

### 8.1 Il codice del trader

Evita gli orari delle sveglie (09:00, 15:40, 18:30, 21:40): ricreare il container interrompe una sveglia in corso (il trader aspetta fino a 5 minuti che finisca, ma meglio non rischiare).

```bash
aws ssm start-session --target "$INSTANCE_ID"      # poi, sul server:
sudo -iu ubuntu
cd /opt/claude-trader
git pull
docker compose up -d --build
docker compose logs --tail 20
docker image prune -f                              # libera lo spazio delle immagini vecchie
```

Per passare a un altro branch (per esempio da `initial-implementation` a `main` dopo il merge):

```bash
git fetch origin
git checkout main
docker compose up -d --build
```

**Tornare indietro** se un aggiornamento dà problemi:

```bash
git log --oneline | head              # trova il commit buono
git checkout <commit>
docker compose up -d --build
```

### 8.2 Claude Code dentro il container

Claude Code si aggiorna ricostruendo l'immagine senza cache:

```bash
docker compose build --pull --no-cache
docker compose up -d
```

### 8.3 Le chiavi

Dal tuo computer, riscrivi i parametri che cambiano (`--overwrite` è già nel comando):

```bash
put_secret TELEGRAM_BOT_TOKEN        # la funzione è definita al punto 3: ridefiniscila se hai aperto un nuovo terminale
```

Poi sul server:

```bash
cd /opt/claude-trader
./deploy/aws/fetch-env.sh
docker compose up -d --force-recreate
```

Per ruotare davvero una chiave bisogna prima invalidare la vecchia: `/revoke` su BotFather per Telegram, *Regenerate* sulla pagina API Keys di Alpaca, un nuovo `claude setup-token` per Claude.

### 8.4 Il sistema operativo

Le patch di sicurezza di Ubuntu si installano da sole. Per aggiornare tutto a mano e riavviare, se serve:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo reboot                           # Docker e il trader ripartono da soli
```

---

## 9. Backup e ripristino

Il trader funziona anche se perde `state/`: il broker ha la verità sui soldi e il primo testimone nuovo ricomincia da lì. Quello che si perde è la storia delle decisioni e dei log. Un backup serve se vuoi conservarla.

**Creare un'immagine (AMI) con il disco** — non ferma l'istanza:

```bash
aws ec2 create-image --instance-id "$INSTANCE_ID" --name "$NAME-$(date +%Y%m%d)" --no-reboot \
  --query ImageId --output text
```

**Elencare le immagini:**

```bash
aws ec2 describe-images --owners self --filters "Name=name,Values=$NAME-*" \
  --query 'Images[].[ImageId,Name,CreationDate]' --output table
```

**Ripristinare:** lancia una nuova istanza con l'AMI del backup, al posto di quella di Ubuntu (punto 5, `--image-id <ami-del-backup>`). In quel caso `user-data` non serve: il repository e Docker sono già nell'immagine.

**Cancellare un backup** (l'immagine e il suo snapshot, separatamente):

```bash
SNAP=$(aws ec2 describe-images --image-ids <ami-id> --query 'Images[0].BlockDeviceMappings[0].Ebs.SnapshotId' --output text)
aws ec2 deregister-image --image-id <ami-id>
aws ec2 delete-snapshot --snapshot-id "$SNAP"
```

---

## 10. Monitoraggio e budget

### 10.1 Recupero automatico dell'istanza (facoltativo)

Se l'hardware sotto l'istanza si guasta, AWS la riavvia su un altro host:

```bash
aws cloudwatch put-metric-alarm --alarm-name claude-trader-recover \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_System --statistic Maximum \
  --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --alarm-actions "arn:aws:automate:$AWS_REGION:ec2:recover"
```

### 10.2 Budget alarm (consigliato)

Ti scrive via email se la spesa del mese supera l'80% della soglia (qui 20 USD: cambiala). Sostituisci l'indirizzo.

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"claude-trader-monthly","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"TUA@EMAIL"}]}]'
```

### 10.3 Il segnale migliore è Telegram

Il ▶️/✅ di ogni sveglia ti dice già se il trader vive. Nessun messaggio alle 09:00 = guarda l'istanza:

```bash
aws ec2 describe-instance-status --instance-ids "$INSTANCE_ID" --include-all-instances \
  --query 'InstanceStatuses[0].[InstanceState.Name,InstanceStatus.Status,SystemStatus.Status]' --output text
```

---

## 11. Fermare, riavviare, cancellare tutto

### 11.1 Pausa (l'istanza resta, il trader si ferma)

Fermare l'istanza interrompe il costo di calcolo, ma **disco e IPv4 pubblico continuano a costare**. Al riavvio Docker e il trader ripartono da soli.

```bash
aws ec2 stop-instances  --instance-ids "$INSTANCE_ID"
aws ec2 start-instances --instance-ids "$INSTANCE_ID"
```

Se la fermi, le sveglie in quel periodo vengono saltate: al riavvio il trader le elenca su Telegram e non le recupera.

### 11.2 Cancellare tutto

Procedi in quest'ordine; l'ultimo passo è irreversibile. Prima, se vuoi, un backup (punto 9).

```bash
# 1. Istanza (cancella anche il suo disco, perché DeleteOnTermination=true)
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"

# 2. Rete
aws ec2 delete-security-group --group-id "$SG_ID"

# 3. Ruolo IAM
aws iam remove-role-from-instance-profile --instance-profile-name $NAME --role-name $NAME
aws iam delete-instance-profile --instance-profile-name $NAME
aws iam detach-role-policy --role-name $NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --role-name $NAME --policy-name read-claude-trader-params
aws iam delete-role --role-name $NAME

# 4. Allarmi e budget (se li hai creati)
aws cloudwatch delete-alarms --alarm-names claude-trader-recover
aws budgets delete-budget --account-id "$ACCOUNT_ID" --budget-name claude-trader-monthly

# 5. Le chiavi in Parameter Store
for p in $(aws ssm get-parameters-by-path --path /claude-trader --query 'Parameters[].Name' --output text); do
  aws ssm delete-parameter --name "$p"
done
```

Poi controlla che non resti niente che costa:

```bash
aws ec2 describe-images --owners self --query 'Images[].[ImageId,Name]' --output table      # AMI dei backup
aws ec2 describe-snapshots --owner-ids self --query 'Snapshots[].[SnapshotId,Description]' --output table
aws ec2 describe-addresses --query 'Addresses[].[PublicIp,AllocationId]' --output table      # Elastic IP: non ne hai creati
```

Il passo finale è fuori da AWS: revoca le chiavi che non ti servono più (`/revoke` su BotFather, *Regenerate* o elimina le chiavi su Alpaca, e invalida il token di `claude setup-token`).

---

## 12. Problemi comuni

| Sintomo | Causa probabile | Cosa fare |
|---|---|---|
| `aws: command not found` | terminale non riaperto dopo l'installazione | chiudi e riapri il terminale |
| `Unable to locate credentials` | credenziali non configurate | `aws configure` o `aws configure sso` (punto 1.3) |
| Errori su nomi tipo `C:/Program Files/Git/claude-trader/...` | Git Bash converte i percorsi | `export MSYS_NO_PATHCONV=1` (punto 2) |
| `Invalid IAM Instance Profile name` | il ruolo non si è ancora propagato | aspetta 20 secondi e ripeti il `run-instances` |
| `PingStatus` resta `None` | ruolo senza `AmazonSSMManagedInstanceCore`, o l'istanza non esce su Internet | controlla il ruolo (punto 4.1); l'istanza deve avere IPv4 pubblico (la subnet di default lo assegna da sola) |
| `start-session` dice che manca il plugin | Session Manager plugin non installato | punto 1.2 |
| `ls /var/lib/claude-trader-bootstrap-done` non trova il file | bootstrap non finito o fallito | `cloud-init status --wait`, poi `sudo tail -50 /var/log/claude-trader-bootstrap.log` |
| `permission denied` su `/var/run/docker.sock` | non sei nel gruppo `docker` | esci e rientra con `sudo -iu ubuntu`, oppure usa `sudo docker ...` |
| `fetch-env.sh`: AccessDenied | la policy IAM non copre il percorso | rivedi `put-role-policy` (punto 4.1): il Resource deve finire con `parameter/claude-trader*` |
| `fetch-env.sh`: nessun parametro | chiavi non salvate, o regione diversa | punto 3; controlla `$AWS_REGION` |
| Durante `docker compose build`: avviso che il "legacy builder" è deprecato | su Ubuntu `docker.io` non include buildx | è solo un avviso, la build funziona lo stesso |
| Il container riparte in loop | errore all'avvio, spesso chiavi mancanti | `docker compose logs --tail 50` |
| Telegram: `HTTP 400 · chat not found` | `TELEGRAM_CHAT_ID` sbagliato, o non hai mai scritto al bot | rifai il punto 3 per quella chiave; scrivi "ciao" al bot |
| Cervello: `401 OAuth access token is invalid` | `CLAUDE_CODE_OAUTH_TOKEN` scaduto o sbagliato | `claude setup-token` sul tuo computer, `put_secret CLAUDE_CODE_OAUTH_TOKEN`, poi `fetch-env.sh` e `docker compose up -d --force-recreate` |
| `una sveglia già fatta` quando provi | il testimone dice che è conclusa | aggiungi `--force` (il briefing non invia ordini) |
| Disco pieno | immagini e log accumulati | `docker image prune -f`; i log di Docker sono già limitati a 5 × 10 MB |
