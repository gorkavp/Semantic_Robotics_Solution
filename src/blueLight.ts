import { Servient } from "@node-wot/core";
import { HttpClientFactory, HttpsClientFactory } from "@node-wot/binding-http";
import { WoT } from "wot-typescript-definitions";

const DEBUG = ["1", "true", "yes", "on"].includes(
	(process.env.DEBUG || "").toLowerCase(),
);

function debugLog(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	console.log(`[debug ${ts}]`, ...args);
}

function listTitles(tds: any[]): string[] {
	return tds
		.map((td) => td?.title)
		.filter((t): t is string => typeof t === "string")
		.sort();
}

function hrefFor(
	td: any,
	kind: "properties" | "actions",
	name: string,
): string | undefined {
	const forms = td?.[kind]?.[name]?.forms;
	if (
		Array.isArray(forms) &&
		forms.length > 0 &&
		typeof forms[0]?.href === "string"
	) {
		return forms[0].href;
	}
	return undefined;
}

async function main() {
	const servient = new Servient();
	servient.addClientFactory(new HttpClientFactory({ allowSelfSigned: true }));
	servient.addClientFactory(new HttpsClientFactory({ allowSelfSigned: true }));

	// Add credentials for Philips Hue light
	servient.addCredentials({
		"urn:dev:ops:32473-HueLight-1": {
			username: "3815651",
			password: "1gDvgr4OsdATB3ww",
		},
	});

	const WoTHelpers = await servient.start();

	console.log("Blue Light Control script started...");
	console.log("Monitoring for blue cube detection...");

	try {
		// Fetch all TDs from Thing Directory
		debugLog("Fetching TD list from http://localhost:8081/things");
		const response = await fetch("http://localhost:8081/things");
		const allTDs = (await response.json()) as any[];
		debugLog("Thing Directory returned TD count:", allTDs?.length);

		// Find specific TDs by title
		const blueLightTD = allTDs.find(
			(td: any) => td.title === "virtualLightBlue",
		);
		const colorSensorTD = allTDs.find(
			(td: any) => td.title === "VirtualColorSensor",
		);

		if (!blueLightTD || !colorSensorTD) {
			throw new Error(
				[
					"Missing required TD(s) for blueLight script.",
					`Have titles: ${listTitles(allTDs).join(", ")}`,
					"Need: virtualLightBlue, VirtualColorSensor",
				].join("\n"),
			);
		}

		debugLog(
			"VirtualColorSensor objectPresence href:",
			hrefFor(colorSensorTD, "properties", "objectPresence"),
		);
		debugLog(
			"VirtualColorSensor color href:",
			hrefFor(colorSensorTD, "properties", "color"),
		);
		debugLog(
			"virtualLightBlue lightState href:",
			hrefFor(blueLightTD, "properties", "lightState"),
		);

		// Consume Things
		const blueLight = await WoTHelpers.consume(blueLightTD);
		const colorSensor = await WoTHelpers.consume(colorSensorTD);

		console.log("Connected to blue light and color sensor");

		// Initialize light to off
		await blueLight.writeProperty("lightState", false);

		// Load Philips Hue light TD from file system (left light for blue)
		let hueLight: WoT.ConsumedThing | null = null;
		const fs = require("fs");
		const path = require("path");
		const shutdownFlagPath = path.join(__dirname, "../.factory-shutdown");

		try {
			const hueTdPath = path.join(__dirname, "../TaskAssets/TDs/lightTD1.json");
			if (fs.existsSync(hueTdPath)) {
				const hueTdJson = JSON.parse(fs.readFileSync(hueTdPath, "utf8"));
				hueLight = await WoTHelpers.consume(hueTdJson as WoT.ThingDescription);
				console.log("✓ Connected to Philips Hue LEFT light (physical - BLUE)");
			} else {
				console.log("ℹ Hue TD file not found - virtual light only mode");
			}
		} catch (err) {
			console.log(
				"ℹ Philips Hue light not available - virtual light only mode:",
				err instanceof Error ? err.message : String(err),
			);
		}

		const COLOR_THRESHOLD = 100;
		let blueCubeDetected = false;
		let lastHeartbeat = Date.now();
		let refreshInterval: NodeJS.Timeout | null = null;

		/**
		 * Control Philips Hue light to blue color
		 * Hue value: 46920 = blue (in Philips Hue 16-bit color space)
		 * Saturation: 254 = fully saturated
		 * Brightness: 254 = maximum brightness
		 */
		const activatePhilipsHueBlue = async () => {
			if (!hueLight) return;

			try {
				await hueLight.invokeAction("setState", {
					on: true,
					hue: 46920, // Blue in Philips Hue color space
					sat: 254, // Full saturation
					bri: 254, // Maximum brightness
					transitiontime: 2, // 200ms transition (unit: 100ms)
				});
				console.log("✓ Physical Philips Hue light turned BLUE");
			} catch (err) {
				console.error("✗ Failed to control Philips Hue light:", err);
			}
		};

		// Monitor color sensor for blue cubes
		console.log("⏳ Monitoring color sensor for blue cubes...");

		const checkInterval = setInterval(async () => {
			try {
				const presence = await colorSensor.readProperty("objectPresence");
				const isPresent = (await presence.value()) as boolean;

				const now = Date.now();
				if (DEBUG && now - lastHeartbeat >= 2000) {
					debugLog(
						"objectPresence:",
						isPresent,
						"blueCubeDetected:",
						blueCubeDetected,
					);
					lastHeartbeat = now;
				}

				if (isPresent && !blueCubeDetected) {
					const colorValue = await colorSensor.readProperty("color");
					const rgb = (await colorValue.value()) as number[];
					const [r, g, b] = rgb;

					// Detect blue cube using threshold-based classification
					if (
						b > COLOR_THRESHOLD &&
						r < COLOR_THRESHOLD &&
						g < COLOR_THRESHOLD
					) {
						console.log(`\n🔵 BLUE CUBE DETECTED! RGB: [${r}, ${g}, ${b}]`);
						console.log("Activating lights...");

						// Turn on virtual blue light in simulation
						await blueLight.writeProperty("lightState", true);
						await blueLight.writeProperty("lightColor", [0, 0, 255]);
						console.log("✓ Virtual blue light activated (simulation)");

						// Turn on physical Philips Hue light
						await activatePhilipsHueBlue();

						blueCubeDetected = true;

						console.log(
							"\n✅ Blue cube detected! Virtual and physical lights activated.",
						);
						console.log("ℹ Lights will remain on until factory shutdown.\n");
					}
				}
			} catch (error) {
				console.error("Error in monitoring loop:", error);
			}
		}, 500);

		let shuttingDown = false;
		// Graceful shutdown handler
		const shutdown = async () => {
			if (shuttingDown) return;
			shuttingDown = true;
			try {
				console.log("\n🛑 Shutting down blue light control...");
				clearInterval(checkInterval);
				clearInterval(shutdownWatchInterval);
				if (refreshInterval) clearInterval(refreshInterval);

				// Turn off virtual light
				try {
					await blueLight.writeProperty("lightState", false);
					console.log("✓ Virtual blue light turned off");
				} catch (err) {
					// Ignore errors if simulation already shut down
				}

				// Turn off Philips Hue light
				if (hueLight) {
					try {
						await hueLight.invokeAction("setState", { on: false });
						console.log("✓ Philips Hue light turned off");
					} catch (err) {
						// Ignore errors if light unreachable
					}
				}

				try {
					await servient.shutdown();
				} catch (err) {
					// Ignore shutdown errors
				}
				console.log("Goodbye!\n");
			} catch (err) {
				// Catch any unexpected errors during shutdown
			} finally {
				process.exit(0);
			}
		};

		// Watch for the transportation completion flag so we can shutdown even if
		// Windows doesn't reliably deliver SIGTERM/SIGINT to child processes.
		const shutdownWatchInterval = setInterval(() => {
			if (shuttingDown) return;
			try {
				if (fs.existsSync(shutdownFlagPath)) {
					void shutdown();
				}
			} catch {
				// ignore
			}
		}, 250);

		// Handle manual interruption and parent process exit
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Detect when parent (concurrently/npm) exits
		if (process.stdin.isTTY === false) {
			process.stdin.on("end", shutdown);
		}
	} catch (error) {
		console.error("Error:", error);
		try {
			await servient.shutdown();
		} catch {}
		process.exit(0); // Exit cleanly even on error
	}
}

main();
