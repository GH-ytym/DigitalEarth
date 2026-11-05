FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /gazetteer ./cmd/gazetteer

FROM scratch
COPY --from=build /gazetteer /gazetteer
USER 65532:65532
ENTRYPOINT ["/gazetteer"]
