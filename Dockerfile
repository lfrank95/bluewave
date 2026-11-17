# Bluewave – fertiges Image (GitHub Container Registry). Enthält den Code; Updates über `docker compose pull`.
# Basis wie Amberwave: PHP 8.3 + Apache (Debian 13 „trixie“). Dazu jellyfin-ffmpeg (GPL) als Transkodier-Motor:
# bringt die Intel-Treiber (iHD, QuickSync/VA-API), HDR-Tone-Mapping und vainfo schon mit.
FROM php:8.3-apache

ARG FFMPEG_PAKET=jellyfin-ffmpeg8

LABEL org.opencontainers.image.title="Bluewave" \
      org.opencontainers.image.description="Self-hosted movie and TV server with Intel QuickSync transcoding" \
      org.opencontainers.image.source="https://github.com/lfrank95/bluewave"

# jellyfin-ffmpeg aus dem offiziellen Jellyfin-Repository (Debian trixie). intel-opencl-icd: OpenCL für Tone-Mapping-Varianten
# (nur amd64; ohne Intel-GPU stört es nicht). Die Paketquelle wird nur für ffmpeg benutzt.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
    && printf 'Types: deb\nURIs: https://repo.jellyfin.org/debian\nSuites: trixie\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' "$(dpkg --print-architecture)" \
        > /etc/apt/sources.list.d/jellyfin.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
        "$FFMPEG_PAKET" \
        libzip-dev \
        libpng-dev \
        libjpeg62-turbo-dev \
        libwebp-dev \
        procps \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then apt-get install -y --no-install-recommends intel-opencl-icd || true; fi \
    && docker-php-ext-configure gd --with-jpeg --with-webp \
    && docker-php-ext-install pdo pdo_mysql zip gd opcache pcntl \
    && a2enmod rewrite headers deflate brotli \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
    && ffmpeg -hide_banner -version | head -n1

RUN { \
    echo 'upload_max_filesize = 20M'; \
    echo 'post_max_size = 22M'; \
    echo 'memory_limit = 512M'; \
    echo 'max_execution_time = 120'; \
    echo 'output_buffering = Off'; \
    echo 'zlib.output_compression = Off'; \
    } > /usr/local/etc/php/conf.d/bluewave.ini \
    && { \
    echo 'opcache.enable = 1'; \
    echo 'opcache.enable_cli = 0'; \
    echo 'opcache.memory_consumption = 128'; \
    echo 'opcache.interned_strings_buffer = 16'; \
    echo 'opcache.max_accelerated_files = 10000'; \
    echo 'opcache.validate_timestamps = 1'; \
    echo 'opcache.revalidate_freq = 2'; \
    } > /usr/local/etc/php/conf.d/opcache.ini \
    && { \
    echo 'expose_php = Off'; \
    echo 'display_errors = Off'; \
    echo 'log_errors = On'; \
    echo 'session.use_strict_mode = 1'; \
    echo 'session.cookie_httponly = 1'; \
    echo 'session.use_only_cookies = 1'; \
    } > /usr/local/etc/php/conf.d/haertung.ini

RUN printf '<Directory /var/www/html>\n    AllowOverride All\n</Directory>\n' > /etc/apache2/conf-available/allow-override.conf \
    && a2enconf allow-override \
    && printf 'ServerTokens Prod\nServerSignature Off\nTraceEnable Off\nServerName bluewave\n' > /etc/apache2/conf-available/haertung.conf \
    && a2enconf haertung

COPY app /var/www/html
# Windows-Client (Installer + version.json), von CI gebaut (Job „client“); lokal leer → /api/v1/client/version meldet keinen
COPY client-dist /opt/bluewave/client

# hls.js (Apache-2.0) für die HLS-Wiedergabe im Browser – feste Version, Prüfsumme aus dem npm-Register
ARG HLSJS_VERSION=1.7.4
ARG HLSJS_SHA1=1857f0cf1b849da5d7ea86b42bce8a321bf912de
RUN curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-${HLSJS_VERSION}.tgz" -o /tmp/hls.tgz \
    && echo "${HLSJS_SHA1}  /tmp/hls.tgz" | sha1sum -c - \
    && mkdir -p /tmp/hls /var/www/html/js/vendor \
    && tar -xzf /tmp/hls.tgz -C /tmp/hls \
    && cp /tmp/hls/package/dist/hls.min.js /var/www/html/js/vendor/hls.min.js \
    && cp /tmp/hls/package/LICENSE /var/www/html/js/vendor/hls.LICENSE.txt \
    && rm -rf /tmp/hls /tmp/hls.tgz
# Treiberpfade setzt jellyfin-ffmpeg selbst (eigene libva samt iHD-Treiber) – hier nichts überschreiben
ENV BLUEWAVE_IMAGE=1
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD php -r '$c = @file_get_contents("http://127.0.0.1/api/v1/ping"); exit($c !== false && str_contains($c, "bluewave") ? 0 : 1);'
CMD ["sh", "/var/www/html/scripts/start.sh"]
