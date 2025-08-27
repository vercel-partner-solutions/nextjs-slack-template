import ngrok from "@ngrok/ngrok";
import dotenv from "dotenv";
import jsonfile from "jsonfile";

const editJsonFile = require("edit-json-file");

dotenv.config({ path: ".env.local", quiet: true });

const authtoken = process.env.NGROK_AUTH_TOKEN;

if (!authtoken) {
	throw new Error("NGROK_AUTH_TOKEN is not set");
}

const startNgrok = async () => {
	return await ngrok.connect({
		authtoken,
		addr: 3000,
	});
};

const copyManifest = async () => {
	const manifest = await jsonfile.readFile("manifest.json");
	await jsonfile.writeFile(".slack/cache/manifest.temp.json", manifest, {
		spaces: 2,
	});
};

const updateManifest = async (url: string | null) => {
	if (!url) return;

	const file = editJsonFile("manifest.json");
	const newUrl = `${url}/api/slack/events`;

	// Update only the specific URL values - preserves formatting
	file.set("features.slash_commands.0.url", newUrl);
	file.set("settings.event_subscriptions.request_url", newUrl);
	file.set("settings.interactivity.request_url", newUrl);

	file.save();
};

const main = async () => {
	try {
		const client = await startNgrok();

		await copyManifest();

		await updateManifest(client.url());

		await client.close();
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error starting ngrok tunnel:", error.message);
		} else {
			console.error("Error starting ngrok tunnel:", error);
		}
	}
};

main();
