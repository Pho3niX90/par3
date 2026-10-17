# Serves the built Par3 marketing site (apps/marketing/dist) at par3.paritylabs.co.za.
# The workflow builds dist first; this image only copies it next to nginx.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY infra/marketing/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/marketing/dist /usr/share/nginx/html

EXPOSE 8080
