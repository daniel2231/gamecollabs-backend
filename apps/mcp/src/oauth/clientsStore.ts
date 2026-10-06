import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Dynamically registered OAuth clients (ChatGPT registers itself once),
 * persisted to a JSON file so a container restart keeps the connection.
 */
export class FileClientsStore implements OAuthRegisteredClientsStore {
  private clients: Map<string, OAuthClientInformationFull> | null = null;
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, "oauth-clients.json");
  }

  private async load(): Promise<Map<string, OAuthClientInformationFull>> {
    if (this.clients) return this.clients;
    try {
      const list = JSON.parse(await readFile(this.file, "utf8")) as OAuthClientInformationFull[];
      this.clients = new Map(list.map((c) => [c.client_id, c]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.clients = new Map();
    }
    return this.clients;
  }

  async getClient(clientId: string) {
    return (await this.load()).get(clientId);
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const clients = await this.load();
    const full: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    clients.set(full.client_id, full);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify([...clients.values()], null, 2));
    await rename(tmp, this.file);
    return full;
  }
}
