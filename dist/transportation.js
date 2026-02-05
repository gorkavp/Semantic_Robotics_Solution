"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@node-wot/core");
const binding_http_1 = require("@node-wot/binding-http");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * RGB color sensor threshold for digital classification
 * Threshold value of 100 (out of 255) provides sufficient signal-to-noise ratio
 * for distinguishing between primary colors in the simulation environment
 */
const COLOR_THRESHOLD = 100;
/** Enable verbose debugging output via environment variable */
const DEBUG = ["1", "true", "yes", "on"].includes((process.env.DEBUG || "").toLowerCase());
/** Position feedback tolerance in meters for determining when Uarm has reached target (default: 20mm) */
const UARM_POSITION_TOLERANCE = Number.parseFloat(process.env.UARM_POSITION_TOLERANCE || "0.020");
/** Maximum timeout for Uarm motion commands before raising an error (default: 30 seconds) */
const UARM_MOVE_TIMEOUT_MS = Number.parseInt(process.env.UARM_MOVE_TIMEOUT_MS || "30000", 10);
/** Position polling interval for closed-loop control feedback (default: 100ms) */
const UARM_POLL_INTERVAL_MS = Number.parseInt(process.env.UARM_POLL_INTERVAL_MS || "100", 10);
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeUnit(unit) {
    const u = String(unit ?? "")
        .trim()
        .toLowerCase();
    if (!u)
        return "";
    // Common synonyms / plural forms
    if (u === "metre" || u === "metres" || u === "meters" || u === "meter")
        return "meter";
    if (u === "centimeter" ||
        u === "centimeters" ||
        u === "centimetre" ||
        u === "centimetres" ||
        u === "cm")
        return "centimeter";
    if (u === "millimeter" ||
        u === "millimeters" ||
        u === "millimetre" ||
        u === "millimetres" ||
        u === "mm")
        return "millimeter";
    if (u === "degree" || u === "degrees" || u === "deg")
        return "degree";
    if (u === "radian" || u === "radians" || u === "rad")
        return "radian";
    // Fallback (kept as-is) so we can still default reasonably.
    return u;
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
/**
 * Convert linear measurements to standard SI base unit (meters)
 * Handles common engineering units: mm, cm, m
 * @param value - Numerical value in source units
 * @param unit - Source unit designation
 * @returns Value converted to meters
 */
function convertToMeters(value, unit) {
    const normalizedUnit = normalizeUnit(unit);
    if (normalizedUnit === "centimeter") {
        return value / 100;
    }
    if (normalizedUnit === "millimeter") {
        return value / 1000;
    }
    return value; // default: meters
}
/**
 * Convert angular measurements to degrees for human-readable robot control
 * @param value - Numerical value in source angular units
 * @param unit - Source unit designation (radians or degrees)
 * @returns Value converted to degrees
 */
function convertToDegrees(value, unit) {
    const normalizedUnit = normalizeUnit(unit);
    if (normalizedUnit === "radian") {
        return value * (180 / Math.PI);
    }
    return value; // default: degrees
}
function convertFromMeters(valueMeters, unit) {
    const normalizedUnit = normalizeUnit(unit);
    if (normalizedUnit === "centimeter")
        return valueMeters * 100;
    if (normalizedUnit === "millimeter")
        return valueMeters * 1000;
    return valueMeters; // meter
}
function convertFromDegrees(valueDegrees, unit) {
    const normalizedUnit = normalizeUnit(unit);
    if (normalizedUnit === "radian")
        return valueDegrees * (Math.PI / 180);
    return valueDegrees; // degree
}
/**
 * Convert standardized position to robot-specific coordinate system
 * Converts from meters/degrees to TD-specified units
 * Required for proper command interfacing with robot controllers
 */
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
    // Query robot's native unit system from Thing Description
    const xUnit = properties?.x?.unit || "meter";
    const yUnit = properties?.y?.unit || "meter";
    const zUnit = properties?.z?.unit || "meter";
    const rxUnit = properties?.rx?.unit || "degree";
    const ryUnit = properties?.ry?.unit || "degree";
    const rzUnit = properties?.rz?.unit || "degree";
    return {
        x: convertFromMeters(pos.x, xUnit),
        y: convertFromMeters(pos.y, yUnit),
        z: convertFromMeters(pos.z, zUnit),
        rx: convertFromDegrees(pos.rx, rxUnit),
        ry: convertFromDegrees(pos.ry, ryUnit),
        rz: convertFromDegrees(pos.rz, rzUnit),
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
        return convertFromMeters(value, unit);
    };
    return {
        x: convertLinear(posMeters.x, xUnit),
        y: convertLinear(posMeters.y, yUnit),
        z: convertLinear(posMeters.z, zUnit),
    };
}
/**
 * Implement closed-loop position control for Uarm robots
 * Continuously polls current position via WoT property and compares against target
 * Uses polling-based feedback since Uarm doesn't provide motion-complete interrupts
 *
 * @param uarm - WoT consumed thing interface for the Uarm robot
 * @param uarmTD - Thing Description containing unit metadata
 * @param targetMeters - Desired 3D position in meters (XYZ)
 * @param options - Control loop parameters (tolerance, timeout, polling rate)
 * @throws Error if position not reached within timeout period
 */
async function waitForUarmAt(uarm, uarmTD, targetMeters, options) {
    const tolerance = options?.tolerance ?? UARM_POSITION_TOLERANCE;
    const timeoutMs = options?.timeoutMs ?? UARM_MOVE_TIMEOUT_MS;
    const pollMs = options?.pollMs ?? UARM_POLL_INTERVAL_MS;
    const start = Date.now();
    let lastObserved;
    let lastObservedRaw;
    let lastLog = 0;
    // Extract position feedback unit specifications from Thing Description
    const curPosProps = uarmTD.properties?.currentPosition?.properties;
    const curXUnit = curPosProps?.x?.unit || "meter";
    const curYUnit = curPosProps?.y?.unit || "meter";
    const curZUnit = curPosProps?.z?.unit || "meter";
    const toMeters = (v, unit) => convertToMeters(v, unit);
    while (Date.now() - start < timeoutMs) {
        let cur;
        try {
            const curProp = await uarm.readProperty("currentPosition");
            cur = (await curProp.value());
        }
        catch (err) {
            /**
             * Handle transient communication errors due to HTTP bridge limitations
             * CoppeliaSim's REST API may drop connections under high load or concurrent requests
             * Implementation: Retry with exponential backoff rather than failing immediately
             */
            if (DEBUG) {
                debugLog("Uarm read currentPosition failed; retrying", {
                    err: String(err),
                    pollMs,
                });
            }
            await sleep(Math.max(pollMs, 250));
            continue;
        }
        const cxRaw = Number(cur?.x);
        const cyRaw = Number(cur?.y);
        const czRaw = Number(cur?.z);
        lastObservedRaw = { x: cxRaw, y: cyRaw, z: czRaw };
        const cx = toMeters(cxRaw, curXUnit);
        const cy = toMeters(cyRaw, curYUnit);
        const cz = toMeters(czRaw, curZUnit);
        lastObserved = { x: cx, y: cy, z: cz };
        // Calculate position error magnitude for each axis (L∞ norm)
        const dx = Math.abs(cx - targetMeters.x);
        const dy = Math.abs(cy - targetMeters.y);
        const dz = Math.abs(cz - targetMeters.z);
        // Target reached when all axes within tolerance (conservative approach)
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
    // Debug logging
    console.log(`[DEBUG_UARM] GoTo Target(M): ${JSON.stringify(posMeters)} Converted: ${JSON.stringify(converted)}`);
    await uarm.invokeAction("goTo", converted);
    await waitForUarmAt(uarm, uarmTD, posMeters, options);
}
/**
 * RGB color classification using threshold-based digital logic
 * Implements simple color space segmentation for primary color detection
 * Algorithm: Check if one channel exceeds threshold while others remain below
 *
 * @param colorSensor - WoT interface to RGB color sensor
 * @returns Detected color class: "red", "blue", "green", or "unknown"
 */
async function detectColor(colorSensor) {
    const colorValue = await colorSensor.readProperty("color");
    const rgb = (await colorValue.value());
    const [r, g, b] = rgb;
    // Red detection: R channel dominant, G and B suppressed
    if (r > COLOR_THRESHOLD && g < COLOR_THRESHOLD && b < COLOR_THRESHOLD) {
        return "red";
    }
    // Blue detection: B channel dominant, R and G suppressed
    if (b > COLOR_THRESHOLD && r < COLOR_THRESHOLD && g < COLOR_THRESHOLD) {
        return "blue";
    }
    // Green detection: G channel dominant, R and B suppressed
    if (g > COLOR_THRESHOLD && r < COLOR_THRESHOLD && b < COLOR_THRESHOLD) {
        return "green";
    }
    return "unknown"; // Ambiguous signal or no object detected
}
/**
 * Platform-agnostic motion command wrapper for heterogeneous robot fleet
 * Abstracts differences between Uarm (3-DOF positioning) and UR3 (6-DOF posing)
 * Automatically handles coordinate transformation and motion completion synchronization
 *
 * @param robot - WoT consumed thing interface
 * @param robotTD - Thing Description for platform detection and unit conversion
 * @param position - Target pose in standard coordinates (meters, degrees)
 */
async function moveTo(robot, robotTD, position) {
    if (isUarm(robotTD)) {
        /**
         * Uarm Swift Pro: 3-axis Cartesian control (XYZ only)
         * Non-blocking motion primitive requires polling-based position feedback
         */
        await uarmGoToAndWait(robot, robotTD, {
            x: position.x,
            y: position.y,
            z: position.z,
        });
    }
    else {
        /**
         * Universal Robots UR3: 6-DOF full pose control (XYZ + Roll-Pitch-Yaw)
         * Blocking motion primitive with built-in trajectory completion feedback
         */
        const convertedPos = convertPosition(position, robotTD);
        await robot.invokeAction("goToPosition", convertedPos);
    }
}
async function main() {
    const servient = new core_1.Servient();
    servient.addClientFactory(new binding_http_1.HttpClientFactory());
    // Cross-process coordination flag: created when the factory is done so
    // other scripts (e.g., light controllers) can shutdown without relying on signals.
    const shutdownFlagPath = path.join(__dirname, "../.factory-shutdown");
    try {
        fs.unlinkSync(shutdownFlagPath);
    }
    catch {
        // ignore if missing
    }
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
        // Log TD units for debugging semantic heterogeneity
        console.log("\n=== Thing Description Units (Semantic Heterogeneity Check) ===");
        // Uarm1 units
        const u1GoTo = uarm1TD.actions?.goTo;
        const u1CurPos = uarm1TD.properties?.currentPosition;
        console.log("VirtualUarm1:");
        console.log(`  goTo input: x=${u1GoTo?.input?.properties?.x?.unit}, y=${u1GoTo?.input?.properties?.y?.unit}, z=${u1GoTo?.input?.properties?.z?.unit}`);
        console.log(`  currentPosition: x=${u1CurPos?.properties?.x?.unit}, y=${u1CurPos?.properties?.y?.unit}, z=${u1CurPos?.properties?.z?.unit}`);
        // Uarm2 units
        const u2GoTo = uarm2TD.actions?.goTo;
        const u2CurPos = uarm2TD.properties?.currentPosition;
        console.log("VirtualUarm2:");
        console.log(`  goTo input: x=${u2GoTo?.input?.properties?.x?.unit}, y=${u2GoTo?.input?.properties?.y?.unit}, z=${u2GoTo?.input?.properties?.z?.unit}`);
        console.log(`  currentPosition: x=${u2CurPos?.properties?.x?.unit}, y=${u2CurPos?.properties?.y?.unit}, z=${u2CurPos?.properties?.z?.unit}`);
        // UR3 units
        const ur3GoToPos = ur3TD.actions?.goToPosition;
        console.log("VirtualUR3:");
        console.log(`  goToPosition input: x=${ur3GoToPos?.input?.properties?.x?.unit}, y=${ur3GoToPos?.input?.properties?.y?.unit}, z=${ur3GoToPos?.input?.properties?.z?.unit}`);
        console.log(`  goToPosition angles: rx=${ur3GoToPos?.input?.properties?.rx?.unit}, ry=${ur3GoToPos?.input?.properties?.ry?.unit}, rz=${ur3GoToPos?.input?.properties?.rz?.unit}`);
        // Sensor units
        if (sensor1TD) {
            const s1ObjDist = sensor1TD.properties?.objectDistance;
            console.log(`VirtualInfraredSensor1: objectDistance unit=${s1ObjDist?.unit}`);
        }
        if (sensor3TD) {
            const s3ObjDist = sensor3TD.properties?.objectDistance;
            console.log(`VirtualInfraredSensor3: objectDistance unit=${s3ObjDist?.unit}`);
        }
        console.log("===============================================================\n");
        /**
         * =======================================================================
         * POSITION DEFINITIONS (World Coordinate Frame)
         *
         * All coordinates extracted from CoppeliaSim scene calibration
         * Units: meters (linear), degrees (angular)
         * Reference frame: CoppeliaSim world origin
         * Organized by workflow stage for clarity
         * =======================================================================
         */
        // === STAGE 1: Uarm1 trajectory waypoints ===
        const spawnPickPosition = {
            // Grasp height at spawn zone (1mm below nominal to ensure contact)
            x: -0.147,
            y: 1.32,
            z: 1.016,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const spawnLiftPosition = {
            // Post-grasp lift height (115mm clearance from spawn surface)
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
            y: 1.55,
            z: 1.225,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1PlacePosition = {
            // Lower position on ConveyorBelt1 to place cube
            x: 0.135,
            y: 1.55,
            z: 1.105,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // === STAGE 2: Uarm2 inter-conveyor transfer positions ===
        const uarm2HomePosition = {
            // Home/ready state - parked above ConveyorBelt1 pickup zone
            // Minimizes travel time when cube arrives from Stage 1
            x: 1.205,
            y: 1.5675,
            z: 1.16,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor1PickPosition = {
            x: 1.205,
            y: 1.5675,
            z: 1.08,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        const conveyor2DropPosition = {
            // ConveyorBelt2 placement position
            // Calibrated to lie within Uarm2's kinematic workspace envelope
            x: 1.46,
            y: 1.285,
            z: 1.1,
            rx: 0,
            ry: 0,
            rz: 0,
        };
        // === STAGE 3: UR3 color sorting positions ===
        const conveyor2PickPosition = {
            // ConveyorBelt2 pickup position for UR3
            // Note: ry=-90° provides downward-facing end-effector orientation
            x: 1.475,
            y: 0.09,
            z: 1.12,
            rx: 0,
            ry: -90,
            rz: 0,
        };
        const ur3IntermediatePosition = {
            // Collision-free waypoint for path planning between CB2 and color sensor
            // Prevents trajectory from intersecting with conveyor belt structures
            // High-precision coordinates from inverse kinematics solver
            x: 1.053,
            y: -0.0876,
            z: 1.174,
            rx: 179.1966,
            ry: -89.8671,
            rz: -109.2019,
        };
        const colorSensorDropPosition = {
            // Position where UR3 holds cube in front of color sensor for detection
            x: 0.8,
            y: 0.22,
            z: 1.145,
            rx: 90,
            ry: -90,
            rz: 0,
        };
        console.log("System ready. Starting full workflow automation...");
        /**
         * Production counters for color-classified inventory tracking
         */
        let redCount = 0;
        let blueCount = 0;
        let greenCount = 0;
        /** Production quota per color class (modify for batch size) */
        const maxCubesPerColor = 1;
        /** Global factory state machine control flag */
        let factoryRunning = true;
        /**
         * Inter-stage handshake protocol flag
         * Implements producer-consumer synchronization between Stage 1 (producer) and Stage 2 (consumer)
         * Prevents race conditions on shared ConveyorBelt1 resource
         */
        let stage2ReadyForCube = true; // Consumer ready signal (Stage 2 starts in ready state)
        let stage3ReadyForCube = true; // Consumer ready signal (Stage 3 starts in ready state)
        /**
         * =======================================================================
         * STAGE 1: Cube initialization and loading subsystem
         *
         * Function: Pick cubes from spawn zone, place on ConveyorBelt1
         * Robot: Uarm1
         * Control: Polling-based closed-loop position feedback
         * Synchronization: Producer in producer-consumer pattern with Stage 2
         * =======================================================================
         */
        const stage1Loop = async () => {
            let stage1Count = 0;
            while (factoryRunning) {
                try {
                    stage1Count++;
                    // HANDSHAKE PROTOCOL: Block until consumer (Stage 2) signals ready
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
                    await sleep(500); // brief pause to ensure stability
                    console.log(`[Stage 1 #${stage1Count}] Closing gripper to grab cube...`);
                    await uarm1.invokeAction("gripClose");
                    console.log(`[Stage 1 #${stage1Count}] Lifting cube...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, spawnLiftPosition);
                    console.log(`[Stage 1 #${stage1Count}] Moving above ConveyorBelt1...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, conveyor1AbovePosition);
                    console.log(`[Stage 1 #${stage1Count}] Moving down to place on ConveyorBelt1...`);
                    await uarmGoToAndWait(uarm1, uarm1TD, conveyor1PlacePosition);
                    await new Promise((resolve) => setTimeout(resolve, 500)); // brief pause to ensure stability
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
        /**
         * =======================================================================
         * STAGE 2: Inter-conveyor transfer subsystem
         *
         * Function: Transfer cubes from ConveyorBelt1 to ConveyorBelt2
         * Robot: Uarm2 (3-DOF)
         * Sensors: IR proximity sensor1 (pickup trigger), sensor2 (approach detection)
         * Control strategy:
         *   1. sensor2 detects approaching cube → Uarm2 returns to home position
         *   2. sensor1 triggers at calibrated distance (275mm) → stop belt
         *   3. Execute synchronized pick-place operation
         * Synchronization: Consumer (Stage 1) / Producer (Stage 3)
         * =======================================================================
         */
        const stage2Loop = async () => {
            let stage2Count = 0;
            /** Infrared sensor trigger setpoint in meters */
            const TARGET_DISTANCE = 0.275; // Note: Simulation returns meters despite TD unit field
            /** Positioning tolerance window: ± meters around target distance */
            const DISTANCE_TOLERANCE = 0.01; // ±10mm acceptable range
            /** Expected final distance after belt stops for optimal pickup (meters) */
            const EXPECTED_PICKUP_DISTANCE = 0.16; // Ideal sensor reading when cube is at conveyor1PickPosition
            /**
             * Read binary object detection state from IR proximity sensor
             * @returns true if object detected within sensor range, false otherwise
             */
            const readPresence = async (s) => {
                if (!s)
                    return false;
                try {
                    const presenceValue = await s.readProperty("objectPresence");
                    return Boolean(await presenceValue.value());
                }
                catch {
                    return false; // Sensor read failure treated as no detection
                }
            };
            /**
             * Read analog distance measurement from IR proximity sensor
             * Handles semantic heterogeneity: converts raw sensor value to meters
             * based on unit specified in sensor Thing Description
             * @returns Distance in meters, or null if sensor unavailable/failed
             */
            const readDistance = async (s) => {
                if (!s)
                    return null;
                try {
                    const distanceValue = await s.readProperty("objectDistance");
                    const rawDistance = Number(await distanceValue.value());
                    // Extract unit from Thing Description (sensor1TD.properties.objectDistance.unit)
                    const sensorUnit = sensor1TD?.properties?.objectDistance?.unit || "meter";
                    // Heuristic: If unit is 'millimeter' but value < 10, likely simulation sending meters
                    // despite the TD claiming millimeters (common issue in heterogeneous mode 1)
                    if (normalizeUnit(sensorUnit) === "millimeter" &&
                        rawDistance > 0 &&
                        rawDistance < 10) {
                        if (DEBUG)
                            console.log(`[DEBUG] Heuristic override: Treated ${rawDistance} as meters despite unit=${sensorUnit}`);
                        return rawDistance;
                    }
                    // Convert to meters using unit-aware converter
                    return convertToMeters(rawDistance, sensorUnit);
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
                    // Ensure belt is running
                    await conveyor1.invokeAction("startBeltForward");
                    /**
                     * PHASE 1: Early detection via upstream sensor
                     * sensor2 provides advance warning of approaching cube
                     * Allows robot to prepare (move to home) while cube travels to pickup zone
                     */
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
                    /**
                     * PHASE 2: Parallel task execution (concurrent control)
                     * Simultaneously: (1) Move Uarm2 to home, (2) Monitor sensor1 for trigger
                     * Reduces cycle time by overlapping robot motion with sensor polling
                     */
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
                    let lastObservedDistance = null;
                    if (sensor1) {
                        while (!pickupReady && factoryRunning && checkCount < maxChecks) {
                            const presence = await readPresence(sensor1);
                            const distance = await readDistance(sensor1);
                            if (presence && distance !== null) {
                                lastObservedDistance = distance;
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
                            await sleep(15);
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
                    // If we never hit the tight tolerance window, still keep the last observed distance
                    // so we can apply a correction rather than always using the default pickup position.
                    if (actualStopDistance === null && lastObservedDistance !== null) {
                        actualStopDistance = lastObservedDistance;
                        console.log(`[Stage 2 #${stage2Count}] Using last observed sensor1 distance for correction: ${actualStopDistance.toFixed(4)}m`);
                    }
                    /**
                     * PHASE 3: Precision stop control
                     * Halt conveyor when cube reaches calibrated pickup position
                     * Dwell time allows mechanical settling (belt deceleration + cube stabilization)
                     */
                    console.log(`[Stage 2 #${stage2Count}] STOPPING ConveyorBelt1...`);
                    await conveyor1.invokeAction("stopBelt");
                    await sleep(500); // 500ms settling time
                    // Ensure Uarm2 is ready before picking
                    console.log(`[Stage 2 #${stage2Count}] Ensuring Uarm2 is ready...`);
                    await uarm2ReadyPromise;
                    // Wait for belt to fully stop and cube to stabilize
                    console.log(`[Stage 2 #${stage2Count}] Waiting for cube to stabilize...`);
                    await sleep(1500);
                    // Recalculate distance after stop for final position adjustment
                    if (sensor1) {
                        const finalDistance = await readDistance(sensor1);
                        if (finalDistance !== null) {
                            actualStopDistance = finalDistance;
                            console.log(`[Stage 2 #${stage2Count}] Final stop distance measured: ${actualStopDistance.toFixed(4)}m`);
                        }
                    }
                    /**
                     * PHASE 4: Adaptive pickup with sensor-based position correction
                     * Compensates for belt stop position variability using sensor feedback
                     */
                    console.log(`[Stage 2 #${stage2Count}] ⚙️ Uarm2 picking cube from ConveyorBelt1...`);
                    /**
                     * Real-time position correction algorithm:
                     * If actualDistance > expected → cube stopped further → shift pickup forward (+x)
                     * If actualDistance < expected → cube stopped closer → shift pickup backward (-x)
                     * Direct 1:1 mapping: sensor distance error = X position correction
                     */
                    const adjustedPickPosition = { ...conveyor1PickPosition };
                    if (actualStopDistance !== null) {
                        console.log(`[DEBUG_STAGE2] Sensor1 Unit in TD: ${sensor1TD?.properties?.objectDistance?.unit}, actualStopDistance: ${actualStopDistance}`);
                        const distanceDeviation = actualStopDistance - EXPECTED_PICKUP_DISTANCE;
                        const xOffset = -distanceDeviation; // Direct correction: 1mm sensor error = 1mm position adjustment
                        adjustedPickPosition.x = conveyor1PickPosition.x + xOffset;
                        console.log(`[Stage 2 #${stage2Count}] Adjusted pickup X: ${conveyor1PickPosition.x.toFixed(3)} → ${adjustedPickPosition.x.toFixed(3)} (distance deviation: ${distanceDeviation.toFixed(4)}m, offset: ${xOffset.toFixed(4)}m)`);
                    }
                    else {
                        console.log(`[Stage 2 #${stage2Count}] No valid sensor1 distance captured; using default pickup position.`);
                    }
                    // Move down to grab position using adjusted position
                    console.log(`[Stage 2 #${stage2Count}]   → Moving to grab position...`);
                    await moveTo(uarm2, uarm2TD, adjustedPickPosition);
                    await sleep(1000);
                    // Close gripper to grab cube
                    console.log(`[Stage 2 #${stage2Count}]   → Closing gripper...`);
                    await uarm2.invokeAction("gripClose");
                    await sleep(1000);
                    // Lift cube to home position (z=1.16)
                    console.log(`[Stage 2 #${stage2Count}]   → Lifting cube to home position...`);
                    await moveTo(uarm2, uarm2TD, {
                        ...adjustedPickPosition,
                        z: 1.17,
                    });
                    // PHASE 5: Transfer to ConveyorBelt2
                    console.log(`[Stage 2 #${stage2Count}] Transferring cube to ConveyorBelt2...`);
                    await uarmGoToAndWait(uarm2, uarm2TD, conveyor2DropPosition, { tolerance: 0.1 });
                    await sleep(500); // brief pause to ensure stability
                    // Wait for Stage 3 to be ready before releasing
                    while (!stage3ReadyForCube && factoryRunning) {
                        if (Date.now() % 2000 < 50) {
                            console.log(`[Stage 2 #${stage2Count}] Waiting for Stage 3 to be ready...`);
                        }
                        await sleep(100);
                    }
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
                    stage2ReadyForCube = true;
                }
                catch (error) {
                    console.error(`[Stage 2 #${stage2Count}] Error:`, error);
                    try {
                        await conveyor1.invokeAction("stopBelt");
                    }
                    catch { }
                    // On error, signal Stage 1 to try again
                    stage2ReadyForCube = true;
                    await sleep(2000);
                }
            }
            console.log("[Stage 2] Loop terminated.");
        };
        /**
         * =======================================================================
         * STAGE 3: Color classification and sorting subsystem
         *
         * Function: Pick cubes from ConveyorBelt2, classify color, sort to bins
         * Robot: Universal Robots UR3 (6-DOF industrial manipulator)
         * Sensors: IR proximity sensor3/4, RGB color sensor
         * Control: Sensor-guided adaptive grasping + color-based decision logic
         * Output: Sorted cubes in red/blue/green collection zones
         * =======================================================================
         */
        const stage3Loop = async () => {
            let stage3Count = 0;
            /** IR sensor trigger distance for ConveyorBelt2 pickup (meters) */
            const TARGET_DISTANCE_CB2 = 0.275;
            /** Positioning tolerance: ±1cm window */
            const DISTANCE_TOLERANCE_CB2 = 0.01; // ±10mm
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
                    // Extract unit from Thing Description (sensor3TD.properties.objectDistance.unit)
                    const sensorUnit = sensor3TD?.properties?.objectDistance?.unit || "meter";
                    // Heuristic for Mode 1
                    if (normalizeUnit(sensorUnit) === "millimeter" &&
                        rawDistance > 0 &&
                        rawDistance < 10) {
                        if (DEBUG)
                            console.log(`[DEBUG] Stage3 Heuristic: Treated ${rawDistance} as meters`);
                        return rawDistance;
                    }
                    // Convert to meters using unit-aware converter
                    return convertToMeters(rawDistance, sensorUnit);
                }
                catch {
                    return null;
                }
            };
            while (factoryRunning) {
                try {
                    stage3Count++;
                    stage3ReadyForCube = true; // Signal ready for next cube
                    console.log(`\n[Stage 3 #${stage3Count}] Ready. Waiting for cube from Stage 2...`);
                    // PHASE 1: Wait for sensor4 to detect approaching cube
                    if (sensor4) {
                        console.log(`[Stage 3 #${stage3Count}] Waiting for sensor4 (or sensor3) to detect cube...`);
                        let detected = false;
                        while (!detected && factoryRunning) {
                            const presence4 = await readPresence(sensor4);
                            // Also check sensor3 in case the cube passed sensor4 while we were busy
                            const presence3 = sensor3 ? await readPresence(sensor3) : false;
                            if (presence4 || presence3) {
                                detected = true;
                                stage3ReadyForCube = false; // Cube detected, mark as busy
                                console.log(`[Stage 3 #${stage3Count}] Cube detected! (s4=${presence4}, s3=${presence3})`);
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
                                    stage3ReadyForCube = false; // Mark as busy
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
                        stage3ReadyForCube = false; // Mark as busy
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
                    // Apply direct 1:1 position correction based on sensor distance error
                    let adjustedConveyor2PickPosition = conveyor2PickPosition;
                    if (sensor3DistanceAtStop !== null) {
                        const deviation = sensor3DistanceAtStop - TARGET_DISTANCE_CB2;
                        const yOffset = deviation; // Direct correction: 1mm sensor error = 1mm position adjustment
                        adjustedConveyor2PickPosition = {
                            ...conveyor2PickPosition,
                            y: conveyor2PickPosition.y + yOffset,
                        };
                        console.log(`[Stage 3 #${stage3Count}] Adjusted pickup Y: ${conveyor2PickPosition.y.toFixed(3)} → ${adjustedConveyor2PickPosition.y.toFixed(3)} (distance deviation: ${deviation.toFixed(4)}m, offset: ${yOffset.toFixed(4)}m)`);
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
                fs.writeFileSync(shutdownFlagPath, new Date().toISOString(), "utf8");
            }
            catch {
                // ignore
            }
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
        // Register SIGINT handler for manual interruption
        process.on("SIGINT", shutdown);
        // Execute graceful shutdown after workflow completes
        await shutdown();
    }
    catch (error) {
        console.error("Fatal error in transportation script:", error);
        process.exit(1);
    }
}
main();
