import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to generate the Caddy configuration`);
  return value;
}

function port(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

const outputPath = resolve(process.argv[2] || ".backslash-caddy.json");
const httpsPort = port("HTTPS_PORT");
const host = required("BACKSLASH_HOST");
const certificate = resolve(required("CERTIFICATE_FILE"));
const key = resolve(required("PRIVATE_KEY_FILE"));
const webUpstream = `${required("WEB_UPSTREAM_HOST")}:${port("WEB_UPSTREAM_PORT")}`;
const wsUpstream = `${required("WS_UPSTREAM_HOST")}:${port("WS_UPSTREAM_PORT")}`;
const adminListen = process.env.CADDY_ADMIN?.trim() || "127.0.0.1:2019";
const certificateTag = "backslash-certificate";

const config = {
  admin: { listen: adminListen },
  apps: {
    tls: {
      certificates: {
        load_files: [{ tags: [certificateTag], certificate, key }],
      },
    },
    http: {
      http_port: httpsPort === 80 ? 8080 : 80,
      https_port: httpsPort,
      servers: {
        backslash: {
          listen: [`:${httpsPort}`],
          automatic_https: { disable: true },
          tls_connection_policies: [
            {
              match: { sni: [host] },
              certificate_selection: { any_tag: [certificateTag] },
            },
            {
              default_sni: host,
              certificate_selection: { any_tag: [certificateTag] },
            },
          ],
          routes: [
            {
              match: [{ path: ["/ws/*"] }],
              handle: [
                { handler: "rewrite", strip_path_prefix: "/ws" },
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: wsUpstream }],
                },
              ],
            },
            {
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: webUpstream }],
                },
              ],
            },
          ],
        },
      },
    },
  },
};

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
