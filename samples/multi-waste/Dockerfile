# Several independent wastes in one image:
#   1. /app/data.bin (1536 KiB) added, then deleted
#   2. /app/config.txt overwritten with different content
#   3. /app/cache/cache.bin (512 KiB) added, then removed with its directory
FROM alpine:3.20
RUN mkdir -p /app && head -c 1572864 /dev/zero > /app/data.bin
RUN echo old-config-value > /app/config.txt
RUN mkdir -p /app/cache && head -c 524288 /dev/zero > /app/cache/cache.bin
RUN echo new-config-value > /app/config.txt
RUN rm /app/data.bin
RUN rm -rf /app/cache
