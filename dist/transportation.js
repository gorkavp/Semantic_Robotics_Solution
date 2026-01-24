"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@node-wot/core");
const binding_http_1 = require("@node-wot/binding-http");
// Color detection thresholds
const COLOR_THRESHOLD = 100;
const DEBUG = ["1", "true", "yes", "on"].includes((process.env.DEBUG || "").toLowerCase());
const UARM_POSITION_TOLERANCE = Number.parseFloat(process.env.UARM_POSITION_TOLERANCE || "0.020");
const UARM_MOVE_TIMEOUT_MS = Number.parseInt(process.env.UARM_MOVE_TIMEOUT_MS || "30000", 10);
const UARM_POLL_INTERVAL_MS = Number.parseInt(process.env.UARM_POLL_INTERVAL_MS || "50", 10);
// Stage 2 tuning knobs
// - If the cube stops too early (not fully under Uarm2), increase STOP_OVERSHOOT_MS.
// - If Uarm2 goes too low when picking, increase PICK_Z_ADJUST_M.
const STAGE2_STOP_OVERSHOOT_MS = Number.parseInt(process.env.STAGE2_STOP_OVERSHOOT_MS || "750", 10);
const STAGE2_PICK_Z_ADJUST_M = Number.parseFloat(process.env.STAGE2_PICK_Z_ADJUST_M || "0.01");
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function debugLog(...args) {
    if (!DEBUG)
        return;
    const ts = new Date().toISOString();
    console.log(`[debug ${ts}]`, ...args);
}
function listTitles(tds) {
    return tds
        .map((td) => td?.title)
        .filter((t) => typeof t === "string")
        .sort();
}
function hrefFor(td, kind, name) {
    const forms = td?.[kind]?.[name]?.forms;
    if (Array.isArray(forms) &&
        forms.length > 0 &&
        typeof forms[0]?.href === "string") {
        return forms[0].href;
    }
    return undefined;
}
function convertToMeters(value, unit) {
    const normalizedUnit = unit.trim().toLowerCase();
    if (normalizedUnit === "centimeter" || normalizedUnit === "cm") {
        return value / 100;
    }
    if (normalizedUnit === "millimeter" || normalizedUnit === "mm") {
        return value / 1000;
    }
    return value; // default: meters
}
function convertToDegrees(value, unit) {
    const normalizedUnit = unit.trim().toLowerCase();
    if (normalizedUnit === "radian" || normalizedUnit === "rad") {
        return value * (180 / Math.PI);
    }
    return value; // default: degrees
}
function normalizePosition(pos, td) {
    const posAction = td.actions?.goToPosition;
    const input = posAction?.input;
    if (!input || typeof input !== "object") {
        return pos;
    }
    const properties = input.properties;
    if (!properties) {
        return pos;
    }
    const xUnit = properties?.x?.unit || "meter";
    const yUnit = properties?.y?.unit || "meter";
    const zUnit = properties?.z?.unit || "meter";
    const rxUnit = properties?.rx?.unit || "degree";
    const ryUnit = properties?.ry?.unit || "degree";
    const rzUnit = properties?.rz?.unit || "degree";
    return {
        x: convertToMeters(pos.x, xUnit),
        y: convertToMeters(pos.y, yUnit),
        z: convertToMeters(pos.z, zUnit),
        rx: convertToDegrees(pos.rx, rxUnit),
        ry: convertToDegrees(pos.ry, ryUnit),
        rz: convertToDegrees(pos.rz, rzUnit),
    };
}
function convertPosition(pos, td) {
    const posAction = td.actions?.goToPosition;
    const input = posAction?.input;
    if (!input || typeof input !== "object") {
        return pos;
    }
    const properties = input.properties;
    if (!properties) {
        return pos;
    }
    const xUnit = properties?.x?.unit || "meter";
    const yUnit = properties?.y?.unit || "meter";
    const zUnit = properties?.z?.unit || "meter";
    const rxUnit = properties?.rx?.unit || "degree";
    const ryUnit = properties?.ry?.unit || "degree";
    const rzUnit = properties?.rz?.unit || "degree";
    return {
        x: xUnit === "centimeter"
            ? pos.x * 100
            : xUnit === "millimeter"
                ? pos.x * 1000
                : pos.x,
        y: yUnit === "centimeter"
            ? pos.y * 100
            : yUnit === "millimeter"
                ? pos.y * 1000
                : pos.y,
        z: zUnit === "centimeter"
            ? pos.z * 100
            : zUnit === "millimeter"
                ? pos.z * 1000
                : pos.z,
        rx: rxUnit === "radian" ? pos.rx * (Math.PI / 180) : pos.rx,
        ry: ryUnit === "radian" ? pos.ry * (Math.PI / 180) : pos.ry,
        rz: rzUnit === "radian" ? pos.rz * (Math.PI / 180) : pos.rz,
    };
}
function isUarm(robotTD) {
    return robotTD.title?.includes("Uarm") || false;
}
function convertUarmGoToInput(posMeters, uarmTD) {
    const goTo = uarmTD.actions?.goTo;
    const inputProps = goTo?.input?.properties;
    const xUnit = inputProps?.x?.unit || "meter";
    const yUnit = inputProps?.y?.unit || "meter";
    const zUnit = inputProps?.z?.unit || "meter";
    const convertLinear = (value, unit) => {
        const u = String(unit).trim().toLowerCase();
        if (u === "centimeter" || u === "cm")
            return value * 100;
        if (u === "millimeter" || u === "mm")
            return value * 1000;
        return value; // meter
    };
    return {
        x: convertLinear(posMeters.x, xUnit),
        y: convertLinear(posMeters.y, yUnit),
        z: convertLinear(posMeters.z, zUnit),
    };
}
async function waitForUarmAt(uarm, uarmTD, targetMeters, options) {
    const tolerance = options?.tolerance ?? UARM_POSITION_TOLERANCE;
    const timeoutMs = options?.timeoutMs ?? UARM_MOVE_TIMEOUT_MS;
    const pollMs = options?.pollMs ?? UARM_POLL_INTERVAL_MS;
    const start = Date.now();
    let lastObserved;
    let lastObservedRaw;
    let lastLog = 0;
    const curPosProps = uarmTD.properties?.currentPosition?.properties;
    const curXUnit = curPosProps?.x?.unit || "meter";
    const curYUnit = curPosProps?.y?.unit || "meter";
    const curZUnit = curPosProps?.z?.unit || "meter";
    const toMeters = (v, unit) => convertToMeters(v, unit);
    while (Date.now() - start < timeoutMs) {
        const curProp = await uarm.readProperty("currentPosition");
        const cur = (await curProp.value());
        const cxRaw = Number(cur?.x);
        const cyRaw = Number(cur?.y);
        const czRaw = Number(cur?.z);
        lastObservedRaw = { x: cxRaw, y: cyRaw, z: czRaw };
        const cx = toMeters(cxRaw, curXUnit);
        const cy = toMeters(cyRaw, curYUnit);
        const cz = toMeters(czRaw, curZUnit);
        lastObserved = { x: cx, y: cy, z: cz };
        const dx = Math.abs(cx - targetMeters.x);
        const dy = Math.abs(cy - targetMeters.y);
        const dz = Math.abs(cz - targetMeters.z);
        if (dx <= tolerance && dy <= tolerance && dz <= tolerance) {
            return;
        }
        if (DEBUG && Date.now() - lastLog > 500) {
            debugLog("Uarm wait", {
                currentMeters: { x: cx, y: cy, z: cz },
                currentRaw: { x: cxRaw, y: cyRaw, z: czRaw },
                currentUnits: { x: curXUnit, y: curYUnit, z: curZUnit },
                targetMeters,
                delta: { dx, dy, dz },
                tolerance,
            });
            lastLog = Date.now();
        }
        await sleep(pollMs);
    }
    throw new Error([
        `Timeout waiting for Uarm to reach target (tol=${tolerance}, timeoutMs=${timeoutMs}).`,
        `Target(m): ${JSON.stringify(targetMeters)}`,
        lastObserved
            ? `Last observed (m): ${JSON.stringify(lastObserved)}`
            : "Last observed (m): <none>",
        lastObservedRaw
            ? `Last observed (raw): ${JSON.stringify(lastObservedRaw)} units=${JSON.stringify({ x: curXUnit, y: curYUnit, z: curZUnit })}`
            : "Last observed (raw): <none>",
    ].join(" "));
}
async function uarmGoToAndWait(uarm, uarmTD, posMeters, options) {
    const converted = convertUarmGoToInput(posMeters, uarmTD);
    await uarm.invokeAction("goTo", converted);
    await waitForUarmAt(uarm, uarmTD, posMeters, options);
}
async function detectColor(colorSensor) {
    const colorValue = await colorSensor.readProperty("color");
    const rgb = (await colorValue.value());
    const [r, g, b] = rgb;
    // Detect red cubes
    if (r > COLOR_THRESHOLD && g < COLOR_THRESHOLD && b < COLOR_THRESHOLD) {
        return "red";
    }
    // Detect blue cubes
    if (b > COLOR_THRESHOLD && r < COLOR_THRESHOLD && g < COLOR_THRESHOLD) {
        return "blue";
    }
    // Detect green cubes
    if (g > COLOR_THRESHOLD && r < COLOR_THRESHOLD && b < COLOR_THRESHOLD) {
        return "green";
    }
    return "unknown";
}
async function moveTo(robot, robotTD, position) {
    if (isUarm(robotTD)) {
        // Uarm uses async 'goTo' with only x, y, z (no rotation).
        // The action is non-synchronous, so we must wait until currentPosition matches.
        await uarmGoToAndWait(robot, robotTD, {
            x: position.x,
            y: position.y,
            z: position.z,
        });
    }
    else {
        // UR3 uses 'goToPosition' with x, y, z, rx, ry, rz
        const convertedPos = convertPosition(position, robotTD);
        await robot.invokeAction("goToPosition", convertedPos);
    }
}
async function pickCube(robot, robotTD, pickPosition) {
    console.log(`  → Opening gripper...`);
    // Open gripper
    if (isUarm(robotTD)) {
        await robot.invokeAction("gripOpen");
    }
    else {
        await robot.invokeAction("openGripper");
    }
    console.log(`  → Moving above cube (z+0.10)...`);
    // Move above the cube
    await moveTo(robot, robotTD, { ...pickPosition, z: pickPosition.z + 0.1 });
    console.log(`  → Moving down to grab (z-0.02)...`);
    // Move down to grab - slightly below cube center for better grip
    await moveTo(robot, robotTD, { ...pickPosition, z: pickPosition.z - 0.02 });
    console.log(`  → Closing gripper to grab cube...`);
    // Close gripper to grab cube
    if (isUarm(robotTD)) {
        await robot.invokeAction("gripClose");
    }
    else {
        await robot.invokeAction("closeGripper");
    }
    console.log(`  → Lifting cube (z+0.10)...`);
    // Lift the cube
    await moveTo(robot, robotTD, { ...pickPosition, z: pickPosition.z + 0.1 });
}
async function placeCube(robot, robotTD, placePosition) {
    console.log(`  → Moving above target (z+0.10)...`);
    // Move above the target
    await moveTo(robot, robotTD, { ...placePosition, z: placePosition.z + 0.1 });
    console.log(`  → Moving down to place (z-0.02)...`);
    // Move down to place - lower to ensure cube is on conveyor
    await moveTo(robot, robotTD, { ...placePosition, z: placePosition.z - 0.02 });
    console.log(`  → Opening gripper to release cube...`);
    // Open gripper to release cube
    if (isUarm(robotTD)) {
        await robot.invokeAction("gripOpen");
    }
    else {
        await robot.invokeAction("openGripper");
    }
    console.log(`  → Moving up (z+0.15)...`);
    // Move up
    await moveTo(robot, robotTD, { ...placePosition, z: placePosition.z + 0.15 });
}
async function main() {
    const servient = new core_1.Servient();
    servient.addClientFactory(new binding_http_1.HttpClientFactory());
    const WoTHelpers = await servient.start();
    console.log("Transportation script started...");
    console.log("Fetching Thing Descriptions from Thing Directory...");
    process.on("unhandledRejection", (reason) => {
        console.error("Unhandled rejection:", reason);
    });
    process.on("uncaughtException", (err) => {
        console.error("Uncaught exception:", err);
        process.exitCode = 1;
    });
    try {
        // Fetch all TDs from Thing Directory
        debugLog("Fetching TD list from http://localhost:8081/things");
        const response = await fetch("http://localhost:8081/things");
        const allTDs = (await response.json());
        debugLog("Thing Directory returned TD count:", allTDs?.length);
        debugLog("TD titles:", listTitles(allTDs));
        // Find TDs for all 3 workflow stages
        const uarm1TD = allTDs.find((td) => td.title === "VirtualUarm1");
        const uarm2TD = allTDs.find((td) => td.title === "VirtualUarm2");
        const ur3TD = allTDs.find((td) => td.title === "VirtualUR3");
        const conveyor1TD = allTDs.find((td) => td.title === "VirtualConveyorBelt1");
        const conveyor2TD = allTDs.find((td) => td.title === "VirtualConveyorBelt2");
        const colorSensorTD = allTDs.find((td) => td.title === "VirtualColorSensor");
        // Sensors for each workflow stage
        const sensor1TD = allTDs.find((td) => td.title === "VirtualInfraredSensor1");
        const sensor2TD = allTDs.find((td) => td.title === "VirtualInfraredSensor2");
        const sensor3TD = allTDs.find((td) => td.title === "VirtualInfraredSensor3");
        const sensor4TD = allTDs.find((td) => td.title === "VirtualInfraredSensor4");
        if (!uarm1TD ||
            !uarm2TD ||
            !ur3TD ||
            !conveyor1TD ||
            !conveyor2TD ||
            !colorSensorTD) {
            const titles = listTitles(allTDs);
            throw new Error([
                "Missing required TD(s) from Thing Directory.",
                `Have titles: ${titles.join(", ")}`,
                "Need: VirtualUarm1, VirtualUarm2, VirtualUR3, VirtualConveyorBelt1, VirtualConveyorBelt2, VirtualColorSensor",
            ].join("\n"));
        }
        debugLog("VirtualUarm1 TD found");
        debugLog("VirtualUarm2 TD found");
        debugLog("VirtualUR3 TD found");
        debugLog("Sensors:", sensor1TD?.title, sensor2TD?.title, sensor3TD?.title, sensor4TD?.title);
        console.log("Consuming Things...");
        // Consume all Things
        const uarm1 = await WoTHelpers.consume(uarm1TD);
        const uarm2 = await WoTHelpers.consume(uarm2TD);
        const ur3 = await WoTHelpers.consume(ur3TD);
        const conveyor1 = await WoTHelpers.consume(conveyor1TD);
        const conveyor2 = await WoTHelpers.consume(conveyor2TD);
        const colorSensor = await WoTHelpers.consume(colorSensorTD);
        const sensor1 = sensor1TD
            ? await WoTHelpers.consume(sensor1TD)
            : null;
        const sensor2 = sensor2TD
            ? await WoTHelpers.consume(sensor2TD)
            : null;
        const sensor3 = sensor3TD
            ? await WoTHelpers.consume(sensor3TD)
            : null;
        const sensor4 = sensor4TD
            ? await WoTHelpers.consume(sensor4TD)
            : null;
        // Position definitions for all 3 stages (from CoppeliaSim scene)
        // Stage 1: Uarm1 positions
        const spawnPosition = {
            x: -0.147,
            y: 1.32,
            z: 1.017,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1DropPosition = {
            x: 0.135,
            y: 1.5379,
            z: 1.125,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // Stage 2: Uarm2 positions
        const uarm2HomePosition = {
            // Uarm2 ready position - waiting above pickup zone
            x: 1.2,
            y: 1.55,
            z: 1.15,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1PickPosition = {
            x: 1.2,
            y: 1.55,
            z: 1.08,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor2DropPosition = {
            // ConveyorBelt2 drop position (adjusted to arm's reachable workspace)
            x: 1.455,
            y: 1.28,
            z: 1.1,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // Stage 3: UR3 positions
        const conveyor2PickPosition = {
            x: 1.475,
            y: 0.1,
            z: 1.12,
            rx: 0,
            ry: -90,
            rz: 0,
        };
        const ur3IntermediatePosition = {
            // Intermediate waypoint when moving from CB2 to color sensor
            x: 1.0537828862689,
            y: -0.08765775628191,
            z: 1.1744665132727,
            rx: 179.19666489927985,
            ry: -89.86710798104652,
            rz: -109.20191005575211,
        };
        const colorSensorPosition = {
            // Position above color sensor for detection
            x: 0.74722,
            y: 0.22579,
            z: 1.114,
            rx: 0,
            ry: -90,
            rz: 0,
        };
        const redBasePosition = {
            x: -0.3,
            y: 0.3,
            z: 0.1,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const blueBasePosition = {
            x: -0.3,
            y: -0.3,
            z: 0.1,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const greenBasePosition = {
            x: -0.3,
            y: 0.0,
            z: 0.1,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // Stage 1: Intermediate positions for Uarm1
        const spawnPickPosition = {
            // Lower position at spawn to grab cube
            x: -0.147,
            y: 1.32,
            z: 1.016,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const spawnLiftPosition = {
            // Lifted position at spawn after grabbing cube
            x: -0.147,
            y: 1.32,
            z: 1.131,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1AbovePosition = {
            // Above ConveyorBelt1 before placing cube
            x: 0.135,
            y: 1.5379,
            z: 1.225,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1PlacePosition = {
            // Lower position on ConveyorBelt1 to place cube
            x: 0.135,
            y: 1.5379,
            z: 1.105,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // Stage 3: Color sensor drop position (UR3 holds cube in front of sensor)
        const colorSensorDropPosition = {
            // Position where UR3 holds cube in front of color sensor for detection
            x: 0.8,
            y: 0.22,
            z: 1.15,
            rx: 90,
            ry: -90,
            rz: 0,
        };
        console.log("System ready. Starting full workflow automation...");
        let redCount = 0;
        let blueCount = 0;
        let greenCount = 0;
        const maxCubesPerColor = 1;
        // Flag to signal all stages to stop
        let factoryRunning = true;
        // Inter-stage synchronization: Stage 1 waits for Stage 2 to be ready
        let stage2ReadyForCube = true; // Stage 2 starts ready
        let stage2ProcessingCube = false; // Flag to prevent Stage 1 interference
        // ========== STAGE 1: Continuous cube spawning ==========
        const stage1Loop = async () => {
            let stage1Count = 0;
            while (factoryRunning) {
                try {
                    stage1Count++;
                    // HANDSHAKE: Wait for Stage 2 to be ready for next cube
                    while (!stage2ReadyForCube && factoryRunning) {
                        if (stage1Count === 1 || stage1Count % 10 === 0) {
                            console.log(`\n[Stage 1 #${stage1Count}] Waiting for Stage 2 to be ready for next cube...`);
                        }
                        await sleep(500);
                    }
                    if (!factoryRunning)
                        break;
                    console.log(`\n[Stage 1 #${stage1Count}] Stage 2 ready. Picking cube from spawn...`);
                    // In a real scenario, we'd check a spawn sensor. For now, proceed directly.
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    console.log(`[Stage 1 #${stage1Count}] Opening gripper...`);
                    await uarm1.invokeAction("gripOpen");
                    console.log(`[Stage 1 #${stage1Count}] Moving to spawn position to grab cube...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, spawnPickPosition);
                    console.log(`[Stage 1 #${stage1Count}] Closing gripper to grab cube...`);
                    await uarm1.invokeAction("gripClose");
                    console.log(`[Stage 1 #${stage1Count}] Lifting cube...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, spawnLiftPosition);
                    console.log(`[Stage 1 #${stage1Count}] Moving above ConveyorBelt1...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, conveyor1AbovePosition);
                    console.log(`[Stage 1 #${stage1Count}] Moving down to place on ConveyorBelt1...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, conveyor1PlacePosition);
                    console.log(`[Stage 1 #${stage1Count}] Opening gripper to release cube...`);
                    await uarm1.invokeAction("gripOpen");
                    console.log(`[Stage 1 #${stage1Count}] Moving back above ConveyorBelt1...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, conveyor1AbovePosition);
                    console.log(`[Stage 1 #${stage1Count}] Starting ConveyorBelt1...`);
                    // IMPORTANT: Stage 2 owns ConveyorBelt1 start/stop.
                    // If Stage 1 starts the belt while Stage 2 is stopping/picking,
                    // the cube can roll away and fall.
                    console.log(`[Stage 1 #${stage1Count}] Cube placed on ConveyorBelt1. Signaling Stage 2...`);
                    // HANDSHAKE: Signal Stage 2 that cube is ready, and we're no longer interfering
                    stage2ReadyForCube = false; // Stage 2 now owns CB1
                    console.log(`[Stage 1 #${stage1Count}] Returning to spawn position...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, spawnLiftPosition);
                }
                catch (error) {
                    console.error(`[Stage 1 #${stage1Count}] Error:`, error);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
            console.log("[Stage 1] Loop terminated.");
        };
        // ========== STAGE 2: Transfer from ConveyorBelt1 to ConveyorBelt2 ==========
        // Professional sequence:
        // 1. sensor2 objectPresence → Uarm2 returns to home/spawn position (ready)
        // 2. sensor1 objectPresence=true AND objectDistance≈0.15 → stop belt, swoop down, grab
        // 3. Transfer to ConveyorBelt2
        const stage2Loop = async () => {
            let stage2Count = 0;
            const TARGET_DISTANCE = 0.275; // Target distance in meters (raw sensor value, already in meters despite TD saying "millimeter")
            const DISTANCE_TOLERANCE = 0.01; // ±20mm tolerance around target
            const readPresence = async (s) => {
                if (!s)
                    return false;
                try {
                    const presenceValue = await s.readProperty("objectPresence");
                    return Boolean(await presenceValue.value());
                }
                catch {
                    return false;
                }
            };
            const readDistance = async (s) => {
                if (!s)
                    return null;
                try {
                    const distanceValue = await s.readProperty("objectDistance");
                    const rawDistance = Number(await distanceValue.value());
                    // CRITICAL: Simulation mode 0 returns values in METERS
                    // Even though TD says "millimeter", the actual values are in meters
                    // So we return the raw value directly (already in meters)
                    return rawDistance;
                }
                catch {
                    return null;
                }
            };
            while (factoryRunning) {
                try {
                    stage2Count++;
                    // HANDSHAKE: Wait for Stage 1 to signal cube is ready
                    while (stage2ReadyForCube && factoryRunning) {
                        console.log(`\n[Stage 2 #${stage2Count}] Ready. Waiting for cube from Stage 1...`);
                        await sleep(1000);
                    }
                    if (!factoryRunning)
                        break;
                    console.log(`\n[Stage 2 #${stage2Count}] Cube received from Stage 1. Taking control of ConveyorBelt1...`);
                    // Mark that we're processing so Stage 1 doesn't interfere
                    stage2ProcessingCube = true;
                    // Ensure belt is running
                    await conveyor1.invokeAction("startBeltForward");
                    // PHASE 1: Wait for sensor2 to detect approaching cube
                    if (sensor2) {
                        console.log(`[Stage 2 #${stage2Count}] Waiting for sensor2 to detect cube...`);
                        let detected = false;
                        while (!detected && factoryRunning) {
                            const presence = await readPresence(sensor2);
                            if (presence) {
                                detected = true;
                                console.log(`[Stage 2 #${stage2Count}] sensor2: objectPresence=true! Cube detected.`);
                            }
                            if (!detected) {
                                await sleep(100);
                            }
                        }
                        if (!factoryRunning)
                            break;
                    }
                    // PHASE 2: Move Uarm2 to home AND monitor sensor1 in parallel
                    console.log(`[Stage 2 #${stage2Count}] Uarm2 moving to home position...`);
                    const uarm2ReadyPromise = (async () => {
                        await uarm2.invokeAction("gripOpen");
                        await moveTo(uarm2, uarm2TD, uarm2HomePosition);
                        console.log(`[Stage 2 #${stage2Count}] Uarm2 ready at home position.`);
                    })();
                    console.log(`[Stage 2 #${stage2Count}] Monitoring sensor1 for objectPresence=true AND objectDistance≈${TARGET_DISTANCE}m...`);
                    let pickupReady = false;
                    let checkCount = 0;
                    const maxChecks = 200;
                    let actualStopDistance = null;
                    if (sensor1) {
                        while (!pickupReady && factoryRunning && checkCount < maxChecks) {
                            const presence = await readPresence(sensor1);
                            const distance = await readDistance(sensor1);
                            if (presence && distance !== null) {
                                console.log(`[Stage 2 #${stage2Count}] sensor1: presence=true, distance=${distance.toFixed(4)}m (target: ${TARGET_DISTANCE}m ±${DISTANCE_TOLERANCE}m)`);
                                if (distance >= TARGET_DISTANCE - DISTANCE_TOLERANCE &&
                                    distance <= TARGET_DISTANCE + DISTANCE_TOLERANCE) {
                                    console.log(`[Stage 2 #${stage2Count}] ✓ Perfect position! objectPresence=true, objectDistance=${distance.toFixed(4)}m`);
                                    actualStopDistance = distance;
                                    pickupReady = true;
                                    break;
                                }
                            }
                            else if (presence && distance === null) {
                                console.log(`[Stage 2 #${stage2Count}] sensor1: presence=true, distance=unavailable`);
                            }
                            else if (!presence) {
                                if (checkCount % 20 === 0) {
                                    console.log(`[Stage 2 #${stage2Count}] sensor1: waiting for objectPresence...`);
                                }
                            }
                            await sleep(30);
                            checkCount++;
                        }
                        if (!pickupReady && factoryRunning) {
                            console.log(`[Stage 2 #${stage2Count}] Timeout waiting for optimal position (${checkCount}/${maxChecks} checks). Proceeding anyway.`);
                        }
                    }
                    else {
                        console.log(`[Stage 2 #${stage2Count}] No sensor1 available. Using time delay.`);
                        await sleep(2000);
                    }
                    if (!factoryRunning)
                        break;
                    // PHASE 3: Stop belt (cube at target position)
                    console.log(`[Stage 2 #${stage2Count}] STOPPING ConveyorBelt1...`);
                    await conveyor1.invokeAction("stopBelt");
                    await sleep(500);
                    // Ensure Uarm2 is ready before picking
                    console.log(`[Stage 2 #${stage2Count}] Ensuring Uarm2 is ready...`);
                    await uarm2ReadyPromise;
                    // Wait for belt to fully stop and cube to stabilize
                    console.log(`[Stage 2 #${stage2Count}] Waiting for cube to stabilize...`);
                    await sleep(1500);
                    // PHASE 4: Pick cube with exact z-heights
                    console.log(`[Stage 2 #${stage2Count}] ⚙️ Uarm2 picking cube from ConveyorBelt1...`);
                    // Calculate adjusted pickup position based on actual stop distance
                    const adjustedPickPosition = { ...conveyor1PickPosition };
                    if (actualStopDistance !== null) {
                        // If stopped earlier (distance > 0.27), cube is further back → decrease x
                        // If stopped later (distance < 0.27), cube is further forward → increase x
                        // Small adjustment: ~0.005m x-adjustment per 0.01m distance variation
                        const distanceDeviation = actualStopDistance - TARGET_DISTANCE;
                        const xOffset = -distanceDeviation * 0.5; // Negative: inverse relationship
                        adjustedPickPosition.x = conveyor1PickPosition.x + xOffset;
                        console.log(`[Stage 2 #${stage2Count}] Adjusted pickup x: ${conveyor1PickPosition.x.toFixed(3)} → ${adjustedPickPosition.x.toFixed(3)} (distance deviation: ${distanceDeviation.toFixed(4)}m, offset: ${xOffset.toFixed(4)}m)`);
                    }
                    // Move down to grab position using adjusted position
                    console.log(`[Stage 2 #${stage2Count}]   → Moving to grab position...`);
                    await moveTo(uarm2, uarm2TD, adjustedPickPosition);
                    // Close gripper to grab cube
                    console.log(`[Stage 2 #${stage2Count}]   → Closing gripper...`);
                    await uarm2.invokeAction("gripClose");
                    await sleep(300);
                    // Lift cube to home position (z=1.15)
                    console.log(`[Stage 2 #${stage2Count}]   → Lifting cube to home position...`);
                    await moveTo(uarm2, uarm2TD, {
                        ...adjustedPickPosition,
                        z: 1.15,
                    });
                    // PHASE 5: Transfer to ConveyorBelt2
                    console.log(`[Stage 2 #${stage2Count}] Transferring cube to ConveyorBelt2...`);
                    await uarmGoToAndWait(uarm2, uarm2TD, conveyor2DropPosition, { tolerance: 0.1 });
                    // Open gripper to release cube
                    console.log(`[Stage 2 #${stage2Count}]   → Releasing cube...`);
                    await uarm2.invokeAction("gripOpen");
                    await sleep(300);
                    // Start ConveyorBelt2 to move cube toward UR3
                    console.log(`[Stage 2 #${stage2Count}]   → Starting ConveyorBelt2...`);
                    await conveyor2.invokeAction("startBeltForward");
                    // Move back slightly after releasing
                    console.log(`[Stage 2 #${stage2Count}]   → Moving back after release...`);
                    await moveTo(uarm2, uarm2TD, {
                        ...conveyor2DropPosition,
                        z: conveyor2DropPosition.z + 0.05,
                    });
                    console.log(`[Stage 2 #${stage2Count}] Transfer complete. Signaling Stage 1 for next cube.`);
                    // HANDSHAKE: Signal Stage 1 we're ready for next cube
                    stage2ProcessingCube = false;
                    stage2ReadyForCube = true;
                }
                catch (error) {
                    console.error(`[Stage 2 #${stage2Count}] Error:`, error);
                    try {
                        await conveyor1.invokeAction("stopBelt");
                    }
                    catch { }
                    // On error, signal Stage 1 to try again
                    stage2ProcessingCube = false;
                    stage2ReadyForCube = true;
                    await sleep(2000);
                }
            }
            console.log("[Stage 2] Loop terminated.");
        };
        // ========== STAGE 3: Pick cubes from ConveyorBelt2 with UR3 ==========
        const stage3Loop = async () => {
            let stage3Count = 0;
            const TARGET_DISTANCE_CB2 = 0.275; // Target distance for sensor3 (similar to sensor1)
            const DISTANCE_TOLERANCE_CB2 = 0.02; // ±20mm tolerance
            const PICKUP_Y_ADJUST_SCALE_CB2 = 0.1; // Reduced scale for smaller adjustments
            const MAX_PICKUP_Y_ADJUST_CB2 = 0.05; // clamp to ±5cm
            const readPresence = async (s) => {
                if (!s)
                    return false;
                try {
                    const presenceValue = await s.readProperty("objectPresence");
                    return Boolean(await presenceValue.value());
                }
                catch {
                    return false;
                }
            };
            const readDistance = async (s) => {
                if (!s)
                    return null;
                try {
                    const distanceValue = await s.readProperty("objectDistance");
                    const rawDistance = Number(await distanceValue.value());
                    return rawDistance;
                }
                catch {
                    return null;
                }
            };
            while (factoryRunning) {
                try {
                    stage3Count++;
                    console.log(`\n[Stage 3 #${stage3Count}] Ready. Waiting for cube from Stage 2...`);
                    // PHASE 1: Wait for sensor4 to detect approaching cube
                    if (sensor4) {
                        console.log(`[Stage 3 #${stage3Count}] Waiting for sensor4 to detect cube...`);
                        let detected = false;
                        while (!detected && factoryRunning) {
                            const presence = await readPresence(sensor4);
                            if (presence) {
                                detected = true;
                                console.log(`[Stage 3 #${stage3Count}] sensor4: objectPresence=true! Cube detected.`);
                            }
                            if (!detected) {
                                await sleep(100);
                            }
                        }
                        if (!factoryRunning)
                            break;
                    }
                    // PHASE 2: Move UR3 to ready position above CB2 AND monitor sensor3 in parallel
                    console.log(`[Stage 3 #${stage3Count}] UR3 moving to ready position above CB2...`);
                    const ur3ReadyPromise = (async () => {
                        await ur3.invokeAction("openGripper");
                        await moveTo(ur3, ur3TD, {
                            ...conveyor2PickPosition,
                            z: conveyor2PickPosition.z + 0.1,
                        });
                        console.log(`[Stage 3 #${stage3Count}] UR3 ready above pickup position.`);
                    })();
                    console.log(`[Stage 3 #${stage3Count}] Monitoring sensor3 for objectPresence=true AND objectDistance≈${TARGET_DISTANCE_CB2}m...`);
                    let pickupReady = false;
                    let sensor3DistanceAtStop = null;
                    let checkCount = 0;
                    const maxChecks = 200;
                    if (sensor3) {
                        while (!pickupReady && factoryRunning && checkCount < maxChecks) {
                            const presence = await readPresence(sensor3);
                            const distance = await readDistance(sensor3);
                            if (presence && distance !== null) {
                                sensor3DistanceAtStop = distance;
                                console.log(`[Stage 3 #${stage3Count}] sensor3: presence=true, distance=${distance.toFixed(4)}m (target: ${TARGET_DISTANCE_CB2}m ±${DISTANCE_TOLERANCE_CB2}m)`);
                                if (distance >= TARGET_DISTANCE_CB2 - DISTANCE_TOLERANCE_CB2 &&
                                    distance <= TARGET_DISTANCE_CB2 + DISTANCE_TOLERANCE_CB2) {
                                    console.log(`[Stage 3 #${stage3Count}] ✓ Perfect position! objectPresence=true, objectDistance=${distance.toFixed(4)}m`);
                                    pickupReady = true;
                                    break;
                                }
                            }
                            else if (presence && distance === null) {
                                console.log(`[Stage 3 #${stage3Count}] sensor3: presence=true, distance=unavailable`);
                            }
                            else if (!presence) {
                                if (checkCount % 20 === 0) {
                                    console.log(`[Stage 3 #${stage3Count}] sensor3: waiting for objectPresence...`);
                                }
                            }
                            await sleep(30);
                            checkCount++;
                        }
                        if (!pickupReady && factoryRunning) {
                            console.log(`[Stage 3 #${stage3Count}] Timeout waiting for optimal position (${checkCount}/${maxChecks} checks). Proceeding anyway.`);
                        }
                    }
                    else {
                        console.log(`[Stage 3 #${stage3Count}] No sensor3 available. Using time delay.`);
                        await sleep(2000);
                    }
                    if (!factoryRunning)
                        break;
                    // PHASE 3: Stop belt (cube at target position)
                    console.log(`[Stage 3 #${stage3Count}] STOPPING ConveyorBelt2...`);
                    await conveyor2.invokeAction("stopBelt");
                    await sleep(500);
                    // Ensure UR3 is ready before picking
                    console.log(`[Stage 3 #${stage3Count}] Ensuring UR3 is ready...`);
                    await ur3ReadyPromise;
                    // Wait for belt to fully stop and cube to stabilize
                    console.log(`[Stage 3 #${stage3Count}] Waiting for cube to stabilize...`);
                    await sleep(1500);
                    // PHASE 4: Pick cube with UR3 (uses 6-coordinate system)
                    console.log(`[Stage 3 #${stage3Count}] ⚙️ UR3 picking cube from ConveyorBelt2...`);
                    // Apply a small distance-based pickup adjustment on Y (similar concept to uarm2 adjustment)
                    let adjustedConveyor2PickPosition = conveyor2PickPosition;
                    if (sensor3DistanceAtStop !== null) {
                        const deviation = sensor3DistanceAtStop - TARGET_DISTANCE_CB2;
                        // If distance is larger than target => add offset; if smaller => subtract offset
                        let yOffset = deviation * PICKUP_Y_ADJUST_SCALE_CB2;
                        yOffset = Math.max(-MAX_PICKUP_Y_ADJUST_CB2, Math.min(MAX_PICKUP_Y_ADJUST_CB2, yOffset));
                        adjustedConveyor2PickPosition = {
                            ...conveyor2PickPosition,
                            y: conveyor2PickPosition.y + yOffset,
                        };
                        console.log(`[Stage 3 #${stage3Count}] Adjusting UR3 pickup Y by ${yOffset.toFixed(4)}m (sensor3 distance=${sensor3DistanceAtStop.toFixed(4)}m, target=${TARGET_DISTANCE_CB2}m)`);
                    }
                    else {
                        console.log(`[Stage 3 #${stage3Count}] No valid sensor3 distance captured; using default UR3 pickup position.`);
                    }
                    // Move down to grab position
                    console.log(`[Stage 3 #${stage3Count}]   → Moving to grab position...`);
                    await moveTo(ur3, ur3TD, adjustedConveyor2PickPosition);
                    // Close gripper to grab cube
                    console.log(`[Stage 3 #${stage3Count}]   → Closing gripper...`);
                    await ur3.invokeAction("closeGripper");
                    await sleep(300);
                    // Lift cube
                    console.log(`[Stage 3 #${stage3Count}]   → Lifting cube...`);
                    await moveTo(ur3, ur3TD, {
                        ...adjustedConveyor2PickPosition,
                        z: adjustedConveyor2PickPosition.z + 0.1,
                    });
                    // Move to intermediate waypoint
                    console.log(`[Stage 3 #${stage3Count}]   → Moving to intermediate position...`);
                    await moveTo(ur3, ur3TD, ur3IntermediatePosition);
                    // Move to color sensor position to hold cube for detection
                    console.log(`[Stage 3 #${stage3Count}]   → Moving to color sensor position...`);
                    await moveTo(ur3, ur3TD, colorSensorDropPosition);
                    // Keep gripper closed and wait for color sensor to detect cube
                    console.log(`[Stage 3 #${stage3Count}] Holding cube in front of sensor, waiting for detection...`);
                    console.log(`[Stage 3 #${stage3Count}] Waiting for color sensor to detect cube...`);
                    let sensorDetected = false;
                    let detectionAttempts = 0;
                    const maxDetectionAttempts = 20;
                    while (!sensorDetected && detectionAttempts < maxDetectionAttempts) {
                        const presenceValue = await colorSensor.readProperty("objectPresence");
                        sensorDetected = Boolean(await presenceValue.value());
                        if (!sensorDetected) {
                            await sleep(100);
                            detectionAttempts++;
                        }
                    }
                    if (!sensorDetected) {
                        console.log(`[Stage 3 #${stage3Count}] Warning: Color sensor did not detect presence. Proceeding anyway.`);
                    }
                    // Detect color while holding cube
                    const color = await detectColor(colorSensor);
                    console.log(`[Stage 3 #${stage3Count}] Detected cube color: ${color}`);
                    // Determine final position based on detected color
                    let finalDropPosition;
                    let skipCube = false;
                    if (color === "red" && redCount < maxCubesPerColor) {
                        // Red: increase y
                        finalDropPosition = {
                            ...colorSensorDropPosition,
                            y: colorSensorDropPosition.y + 0.25, // Increase y for red (target: 0.47)
                        };
                        redCount++;
                    }
                    else if (color === "blue" && blueCount < maxCubesPerColor) {
                        // Blue: decrease y
                        finalDropPosition = {
                            ...colorSensorDropPosition,
                            y: colorSensorDropPosition.y - 0.25, // Decrease y for blue (target: -0.03)
                        };
                        blueCount++;
                    }
                    else if (color === "green" && greenCount < maxCubesPerColor) {
                        // Green: drop at intermediate position
                        finalDropPosition = { ...ur3IntermediatePosition };
                        greenCount++;
                    }
                    else {
                        console.log(`[Stage 3 #${stage3Count}] Skipping cube: color=${color} (quota reached or unknown)`);
                        skipCube = true;
                        finalDropPosition = { ...colorSensorDropPosition };
                    }
                    // For green cubes, move directly to intermediate position and drop
                    if (color === "green" && !skipCube) {
                        console.log(`[Stage 3 #${stage3Count}]   → Moving to intermediate position for green cube...`);
                        await moveTo(ur3, ur3TD, ur3IntermediatePosition);
                        // Open gripper to release cube
                        console.log(`[Stage 3 #${stage3Count}]   → Releasing green cube at intermediate position...`);
                        await ur3.invokeAction("openGripper");
                        await sleep(300);
                    }
                    else {
                        // For red/blue cubes, move to color-specific position
                        console.log(`[Stage 3 #${stage3Count}]   → Moving to ${color} drop position (y=${finalDropPosition.y.toFixed(3)})...`);
                        await moveTo(ur3, ur3TD, finalDropPosition);
                        // Open gripper to release cube
                        console.log(`[Stage 3 #${stage3Count}]   → Releasing cube at ${color} position...`);
                        await ur3.invokeAction("openGripper");
                        await sleep(300);
                        // Move up
                        console.log(`[Stage 3 #${stage3Count}]   → Moving up after release...`);
                        await moveTo(ur3, ur3TD, {
                            ...finalDropPosition,
                            z: finalDropPosition.z + 0.1,
                        });
                        // Return to intermediate/home position
                        console.log(`[Stage 3 #${stage3Count}]   → Returning to intermediate position...`);
                        await moveTo(ur3, ur3TD, ur3IntermediatePosition);
                    }
                    if (!skipCube) {
                        console.log(`[Stage 3 #${stage3Count}] Cube sorted to ${color} position. Counts: red=${redCount}, blue=${blueCount}, green=${greenCount}`);
                    }
                    // Check if all quotas met
                    if (redCount >= maxCubesPerColor &&
                        blueCount >= maxCubesPerColor &&
                        greenCount >= maxCubesPerColor) {
                        console.log(`[Stage 3 #${stage3Count}] All color quotas met. Stopping factory...`);
                        factoryRunning = false;
                        break;
                    }
                }
                catch (error) {
                    console.error(`[Stage 3 #${stage3Count}] Error:`, error);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
            console.log("[Stage 3] Loop terminated.");
        };
        // Run all three stages in parallel
        await Promise.all([stage1Loop(), stage2Loop(), stage3Loop()]);
        console.log("\n=== All cubes sorted! Stopping factory ===");
        await conveyor1.invokeAction("stopBelt");
        await conveyor2.invokeAction("stopBelt");
        console.log("Transportation workflow complete!");
        // Graceful shutdown
        const shutdown = async () => {
            console.log("\n=== Shutting down Transportation ===");
            try {
                await conveyor1.invokeAction("stopBelt");
                await conveyor2.invokeAction("stopBelt");
                console.log("All conveyors stopped");
            }
            catch (err) {
                console.error("Error stopping conveyors during shutdown:", err);
            }
            await servient.shutdown();
            console.log("Servient shut down. Exiting.");
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
    }
    catch (error) {
        console.error("Fatal error in transportation script:", error);
        process.exit(1);
    }
}
main();
