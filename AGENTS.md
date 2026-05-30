## Imported Claude Cowork project instructions

I want to build a high-performance web application for real-time visualization of dynamic vehicle data on a map.

Project goal:
Create a scalable traffic visualization platform using:
- Angular frontend
- Spring Boot backend
- OpenStreetMap
- WebGL rendering
- Real-time vehicle movement

Main objective:
Efficiently display and manage thousands of moving vehicles simultaneously while maintaining smooth performance.

The application should feel like:
- a professional smart mobility dashboard
- a real-time traffic monitoring platform
- a scalable geographic visualization system

NOT:
- a video game
- a heavy 3D simulator
- an ultra realistic city simulator

==================================================
TECH STACK
==================================================

Frontend:
- Angular
- TypeScript
- MapLibre GL JS
- WebGL2
- RxJS
- SCSS

Backend:
- Spring Boot
- WebSocket
- REST API
- Maven
- Java 21

==================================================
CORE FEATURES
==================================================

Frontend:
- Interactive OpenStreetMap map
- Smooth pan/zoom
- Real-time moving vehicles
- Vehicle selection
- Heatmaps
- Filters
- Statistics dashboard
- Performance metrics
- Dark modern UI

Backend:
- Vehicle simulation
- Vehicle generation
- Position updates
- Traffic logic
- Path generation
- WebSocket streaming
- Scalable update loop

==================================================
IMPORTANT PERFORMANCE REQUIREMENTS
==================================================

Performance is the MOST important aspect.

The system must:
- handle thousands of vehicles smoothly
- maintain stable FPS
- avoid UI freezing
- avoid unnecessary rendering
- scale efficiently

Rules:
- use WebGL instanced rendering
- avoid rendering vehicles as DOM elements
- use batching where possible
- use spatial partitioning/grid
- avoid O(n²) operations
- use WebSockets for realtime updates
- optimize memory allocations
- use workers/async processing when useful

==================================================
VISUAL STYLE
==================================================

The application should look:
- modern
- smooth
- professional
- clean
- responsive

Use:
- dark theme
- subtle glow effects
- smooth animations
- lightweight effects
- minimal but polished UI

Avoid:
- overcomplicated 3D graphics
- heavy visual effects
- unnecessary realism

==================================================
ARCHITECTURE REQUIREMENTS
==================================================

Keep architecture:
- modular
- scalable
- maintainable
- clean

Separate clearly:
- rendering
- simulation
- networking
- UI
- business logic

==================================================
WHAT I WANT FROM YOU
==================================================

1. Propose the complete architecture
2. Explain project structure
3. Explain communication between frontend/backend
4. Suggest best rendering strategy
5. Suggest best realtime update strategy
6. Explain performance optimizations
7. Suggest scalable vehicle simulation approach
8. Then create the project step by step

IMPORTANT:
Work incrementally.
Do not overengineer.
Prioritize performance and scalability first.
