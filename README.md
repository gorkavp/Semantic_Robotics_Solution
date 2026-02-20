# Semantic Robotics Solution

This solution implements an automated cube sorting system using Web of Things (WoT) principles with semantic heterogeneity support.

## Solution Overview

The solution consists of 3 TypeScript scripts that can run independently on separate devices:

1. **transportation.ts** - Main cube sorting logic that:
   - Detects cube colors using the color sensor
   - Transports red cubes to the red base (ColorSensorBaseRed)
   - Transports blue cubes to the blue base
   - Discards green cubes (no base placement)
   - Handles semantic heterogeneity (different units across devices)
   - Processes at least one cube of each color then exits

2. **redLight.ts** - Red light control that:
   - Monitors for red cube detection
   - Triggers the virtual red light in simulation
   - Prepares for Philips Hue physical light integration

3. **blueLight.ts** - Blue light control that:
   - Monitors for blue cube detection
   - Triggers the virtual blue light in simulation
   - Prepares for Philips Hue physical light integration

## Key Features

### Semantic Heterogeneity Support

The transportation script handles different unit systems:

- **Distance**: meters, centimeters, millimeters
- **Angles**: degrees, radians

The code automatically detects units from Thing Descriptions and converts values accordingly, ensuring compatibility with:

- `node simulationServer.js 0` (forces meter units)
- `node simulationServer.js 1` (uses random units)

### WoT Architecture

- Fetches Thing Descriptions dynamically from the Thing Directory
- Uses WoT Consumable Thing API
- Supports device discovery and binding
- Enables independent script execution on different devices

## Installation

```bash
npm install
```

This installs all required dependencies:

- `@node-wot/core`, `@node-wot/binding-http`, `@node-wot/binding-coap` - WoT libraries
- `wot-typescript-definitions` - TypeScript definitions for WoT
- `typescript` - TypeScript compiler
- `concurrently` - Run multiple scripts in parallel
- `@tsconfig/node20` - TypeScript config for Node.js 20

## Build

```bash
npm run build
```

This compiles TypeScript source files from `src/` to JavaScript in `dist/`.

## Usage

### Start All Scripts (Recommended)

```bash
npm start
```

This runs all three scripts concurrently:

- Transportation logic
- Red light control
- Blue light control

### Run Scripts Individually

```bash
npm run transport    # Transportation only
npm run red-light    # Red light control only
npm run blue-light   # Blue light control only
```

## Prerequisites

Before running the solution:

1. Start Docker Compose (Thing Directory):

   ```bash
   docker compose up
   ```

2. Start the simulation server with desired unit mode:

   ```bash
   node simulationServer.js 0   # Meter units (less randomness)
   node simulationServer.js 1   # Random units (full semantic test)
   ```

3. Open CoppeliaSim with the task scene:
   - File → Open Scene → `TaskAssets/IoT_Remote_Lab.ttt`

## How It Works

1. **Transportation Script**:
   - Connects to robot arm, color sensor, and conveyor belt
   - Starts conveyor to bring cubes
   - Detects cube color when object is present
   - Picks cube from source position
   - Places cube at appropriate destination:
     - Red → Red base (triggers red light)
     - Blue → Blue base (triggers blue light)
     - Green → Discard area (no light)
   - Continues until one of each color is processed
   - Exits automatically

2. **Light Control Scripts**:
   - Monitor the color sensor continuously
   - Detect when a cube of the target color appears
   - Activate the corresponding virtual light
   - Ready for Philips Hue integration (TODO section marked)

## Project Structure

```
.
├── src/
│   ├── transportation.ts    # Main sorting logic
│   ├── redLight.ts          # Red light control
│   └── blueLight.ts         # Blue light control
├── dist/                    # Compiled JavaScript (generated)
├── TaskAssets/
│   ├── IoT_Remote_Lab.ttt   # CoppeliaSim scene
│   └── TDs/                 # Thing Descriptions
├── package.json             # NPM configuration
├── tsconfig.json           # TypeScript configuration
└── docker-compose.yml       # Thing Directory setup
```

## Testing

The solution has been designed to work with both unit modes:

- **Mode 0** (`node simulationServer.js 0`): All devices use meters
- **Mode 1** (`node simulationServer.js 1`): Devices use random units

The automatic unit conversion ensures consistent behavior in both modes.
