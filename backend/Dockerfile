# Build stage — compile hydroxide so we can run `auth` from the backend container.
# The serve container is a separate service; both share /data via a volume so
# auth credentials registered here are visible to the IMAP server.
FROM golang:1.24-alpine AS hydroxide_build
RUN apk add --no-cache git
RUN go install github.com/emersion/hydroxide/cmd/hydroxide@latest

FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

# Hydroxide CLI for ProtonMail account auth
COPY --from=hydroxide_build /go/bin/hydroxide /usr/local/bin/hydroxide
ENV XDG_CONFIG_HOME=/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
