# Local/container build of the Coax marketing site.
# Mirrors the Railway deployment (nixpacks.toml + railway.toml): PHP 8.2,
# composer install, PHP's built-in server pointed at public/.
#
#   docker compose up --build        # from web/, then http://localhost:8080
#
# APP_ENV is intentionally unset for local runs (base config.json, debug on).
# Set APP_ENV=pd to exercise the production config overlay.

FROM composer:2 AS deps
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-progress --optimize-autoloader

FROM php:8.2-cli
WORKDIR /app
COPY . .
COPY --from=deps /app/vendor ./vendor
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "php -S 0.0.0.0:${PORT} -t public public/index.php"]
