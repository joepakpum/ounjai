FROM docker.io/library/node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
ENV NGINX_ENVSUBST_FILTER=^NGINX_DNS_RESOLVER$
COPY --chmod=755 05-podman-dns.envsh /docker-entrypoint.d/05-podman-dns.envsh
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
