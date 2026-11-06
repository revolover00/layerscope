# /app/config.bin is written twice with different content; the first copy
# is dead weight shipped in an earlier layer.
FROM alpine:3.20
RUN mkdir -p /app && head -c 1048576 /dev/zero | tr '\0' '1' > /app/config.bin
RUN head -c 1048576 /dev/zero | tr '\0' '2' > /app/config.bin
