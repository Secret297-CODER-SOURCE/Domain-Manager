# Hydroxide — open-source ProtonMail Bridge implementation
# https://github.com/emersion/hydroxide
FROM golang:1.24-alpine AS build
RUN apk add --no-cache git
RUN go install github.com/emersion/hydroxide/cmd/hydroxide@latest

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tini && mkdir -p /data
COPY --from=build /go/bin/hydroxide /usr/local/bin/hydroxide
ENV XDG_CONFIG_HOME=/data
# Run as root — same UID as backend container — so /data/hydroxide/auth.json
# created from either side is mutually readable. Single-purpose isolated container.
VOLUME /data
EXPOSE 1143 1025 8081
# Bind to all interfaces inside the container so the backend can reach IMAP at hydroxide:1143
ENTRYPOINT ["/sbin/tini", "--"]
# `-app-version web-mail@...` makes Proton's API treat us as the web client
# instead of "Other" (which is heavily CAPTCHA'd on unknown IPs).
CMD ["hydroxide", "-debug", \
     "-app-version", "web-mail@5.0.999.999-dev", \
     "-imap-host", "0.0.0.0", "-smtp-host", "0.0.0.0", "serve"]
