# A ~2 MiB file is added in one layer and deleted in the next.
# The bytes still ship inside the earlier layer, so waste is expected.
FROM alpine:3.20
RUN mkdir -p /app && head -c 2097152 /dev/zero > /app/big.bin
RUN rm /app/big.bin
