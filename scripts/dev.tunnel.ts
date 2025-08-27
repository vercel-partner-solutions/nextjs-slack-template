import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import ngrok from "@ngrok/ngrok";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const authtoken = process.env.NGROK_AUTH_TOKEN;

if (!authtoken) {
	throw new Error("NGROK_AUTH_TOKEN is not set");
}

const getDevPort = () => {
	let port = 3000;
	// Check environment variable first
	if (process.env.PORT) {
		port = parseInt(process.env.PORT, 10);
	}

	// Check package.json dev script for --port flag
	try {
		const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
		const devScript = packageJson.scripts?.dev;
		if (devScript) {
			const portMatch = devScript.match(/--port\s+(\d+)/);
			if (portMatch) {
				port = parseInt(portMatch[1], 10);
			}
		}
	} catch { }

	return port;
};

const startNgrok = async () => {
	return await ngrok.connect({
		authtoken,
		addr: getDevPort(),
	});
};

const backupManifest = async (manifestContent: string) => {
	await fs.writeFile(".slack/cache/manifest.temp.json", manifestContent);
};

const removeTempManifest = async () => {
	await fs.unlink(".slack/cache/manifest.temp.json");
};

const restoreManifest = async () => {
	const manifest = await fs.readFile(
		".slack/cache/manifest.temp.json",
		"utf-8",
	);
	await fs.writeFile("manifest.json", manifest);
};

const updateManifest = async (url: string | null) => {
	if (!url) return { updated: false, originalContent: "" };

	const file = await fs.readFile("manifest.json", "utf-8");
	const json = JSON.parse(file);

	const newUrl = `${url}/api/slack/events`;
	const currentUrl = json.settings.event_subscriptions.request_url;

	// Skip if URL hasn't changed
	if (currentUrl === newUrl) {
		return { updated: false, originalContent: "" };
	}

	json.features.slash_commands[0].url = newUrl;
	json.settings.event_subscriptions.request_url = newUrl;
	json.settings.interactivity.request_url = newUrl;

	await fs.writeFile("manifest.json", JSON.stringify(json, null, 2));
	return { updated: true, originalContent: file };
};

const cleanup = async (
	client: ngrok.Listener | null,
	manifestWasUpdated: boolean,
) => {
	if (client) {
		await client.close();
	}
	if (manifestWasUpdated) {
		await restoreManifest();
		await removeTempManifest();
	}
};

const runDevCommand = () => {
	return spawn("pnpm", ["dev"], { stdio: "inherit" });
};

const main = async () => {
	let client: ngrok.Listener | null = null;
	let manifestWasUpdated = false;
	let isCleaningUp = false;

	const handleExit = async () => {
		if (isCleaningUp) return;
		isCleaningUp = true;
		await cleanup(client, manifestWasUpdated);
		process.exit(0);
	};

	process.on("SIGINT", handleExit);
	process.on("SIGTERM", handleExit);

	try {
		client = await startNgrok();

		// Update manifest and backup original content in one pass
		const { updated, originalContent } = await updateManifest(client.url());
		manifestWasUpdated = updated;

		if (manifestWasUpdated) {
			await backupManifest(originalContent);
		}

		const devProcess = runDevCommand();

		// Keep the script running while pnpm dev is active
		await new Promise<void>((resolve) => {
			devProcess.on("exit", () => {
				resolve();
			});
		});
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error starting ngrok tunnel:", error.message);
		} else {
			console.error("Error starting ngrok tunnel:", error);
		}
	} finally {
		if (!isCleaningUp) {
			await cleanup(client, manifestWasUpdated);
		}
	}
};

main();
