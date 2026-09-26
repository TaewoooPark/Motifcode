import { spawn } from "node:child_process";

/** Browser launches are host UI actions. Never execute a URL through a shell. */
export function externalUrl(value: string | URL): URL {
  const text = String(value);
  if (text.length > 16_384 || /[\x00-\x20\x7f]/.test(text)) throw new Error("Invalid browser URL.");
  const url = new URL(text);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) throw new Error("Browser URL must use HTTPS (or loopback HTTP) without embedded credentials.");
  return url;
}

export async function openExternalUrl(value: URL): Promise<void> {
  const url = externalUrl(value).href;
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command as string, args as string[], { stdio: "ignore", shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Browser launch timed out.")); }, 10_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Could not open the browser.")); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Could not open the browser.")); });
  });
}
