# Project Overview

<cite>
**Referenced Files in This Document**
- [README.md](file://README.md)
- [pubspec.yaml](file://pubspec.yaml)
- [backend/package.json](file://backend/package.json)
- [frontend/package.json](file://frontend/package.json)
- [backend/server.js](file://backend/server.js)
- [backend/engine/main.py](file://backend/engine/main.py)
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js)
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js)
- [backend/models/Project.js](file://backend/models/Project.js)
- [lib/main.dart](file://lib/main.dart)
- [frontend/src/App.jsx](file://frontend/src/App.jsx)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js)
- [backend/services/llmParser.js](file://backend/services/llmParser.js)
- [backend/engine/parser.py](file://backend/engine/parser.py)
- [DEPLOY.md](file://DEPLOY.md)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction
Velora Route Optimizer is an AI-powered vehicle routing optimization platform designed to streamline employee transportation logistics. It unifies a Flutter mobile application, a React web interface, and a Python optimization engine behind a shared Node.js backend API. The platform automates the entire workflow: data ingestion from diverse sources (Excel, PDF, text, images), AI-driven parsing into a canonical format, genetic algorithm-based optimization, and multi-platform deployment for Android, iOS, Web, and desktop environments.

Target audience includes fleet managers, HR coordinators, and logistics planners who need efficient, scalable solutions to reduce operational costs, improve on-time performance, and optimize driver/vehicle utilization. The platform solves the challenge of manual route planning by combining intelligent data parsing with high-performance optimization to deliver actionable insights and optimized itineraries.

Key benefits:
- Unified multi-platform experience (mobile, web, desktop)
- Intelligent parsing powered by Google Generative AI
- Robust optimization using a parallelized genetic algorithm
- End-to-end orchestration from ingestion to results
- Production-ready deployment guidance for cloud platforms

Problem-solving approach:
- Ingest structured/unstructured inputs from spreadsheets, documents, and free-form text
- Use an LLM to extract and normalize a canonical JSON schema
- Feed the canonical dataset into a Python optimization engine that runs multiple strategies concurrently
- Aggregate and present results with metrics such as total cost, time, and savings against baseline

## Project Structure
The repository is organized into four primary areas:
- Flutter mobile application (lib/)
- React web application (frontend/)
- Node.js backend API (backend/)
- Python optimization engine (backend/engine/)

```mermaid
graph TB
subgraph "Mobile App (Flutter)"
FLUTTER_LIB["lib/"]
end
subgraph "Web App (React)"
REACT_APP["frontend/src/"]
end
subgraph "Backend API (Node.js)"
BACKEND["backend/server.js"]
CONTROLLERS["backend/controllers/"]
MODELS["backend/models/"]
SERVICES["backend/services/"]
ENGINE["backend/engine/"]
end
subgraph "Optimization Engine (Python)"
PY_MAIN["backend/engine/main.py"]
PY_PARSER["backend/engine/parser.py"]
end
FLUTTER_LIB --> BACKEND
REACT_APP --> BACKEND
BACKEND --> MODELS
BACKEND --> SERVICES
SERVICES --> ENGINE
ENGINE --> PY_MAIN
PY_MAIN --> PY_PARSER
```

**Diagram sources**
- [lib/main.dart](file://lib/main.dart#L1-L220)
- [frontend/src/App.jsx](file://frontend/src/App.jsx#L1-L60)
- [backend/server.js](file://backend/server.js#L1-L56)
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js#L1-L117)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js#L1-L73)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/engine/parser.py](file://backend/engine/parser.py#L1-L278)

**Section sources**
- [README.md](file://README.md#L1-L17)
- [pubspec.yaml](file://pubspec.yaml#L1-L117)
- [backend/package.json](file://backend/package.json#L1-L28)
- [frontend/package.json](file://frontend/package.json#L1-L48)
- [DEPLOY.md](file://DEPLOY.md#L1-L169)

## Core Components
- Flutter mobile application: Provides secure authentication, navigation, and UI for dashboards, metrics, and project management. It loads environment configuration and integrates with Google Maps for visualization.
- React web application: Offers a responsive dashboard, drag-and-drop file upload, analytics, and project-specific views with map overlays.
- Node.js backend: Exposes RESTful APIs for authentication, project lifecycle, ingestion, parsing, and orchestration of the Python optimization engine. It manages uploads, enforces CORS, and persists data in MongoDB.
- Python optimization engine: Implements a genetic algorithm solver that evaluates multiple strategies in parallel, computes distance matrices, and produces optimized routes with metrics and feasibility indicators.
- AI/LLM integration: Uses Google Generative AI to parse heterogeneous inputs into a canonical JSON schema, enabling robust downstream optimization.

Practical use cases:
- Daily commute routing for employees with time windows and preferences
- Shared ride optimization with capacity constraints and vehicle categories
- Cost/time minimization against historical baselines
- Multi-city operations with depot locations and vehicle availability

**Section sources**
- [lib/main.dart](file://lib/main.dart#L1-L220)
- [frontend/src/App.jsx](file://frontend/src/App.jsx#L1-L60)
- [backend/server.js](file://backend/server.js#L1-L56)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/services/llmParser.js](file://backend/services/llmParser.js#L1-L170)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)

## Architecture Overview
The system follows a client-server pattern with a shared backend serving both Flutter and React clients. The backend orchestrates ingestion, parsing, and execution of the Python optimization engine, returning structured results consumed by the UIs.

```mermaid
graph TB
CLIENT_MOBILE["Flutter App<br/>lib/main.dart"]
CLIENT_WEB["React App<br/>frontend/src/App.jsx"]
API["Node.js API<br/>backend/server.js"]
AUTH["Auth Controllers<br/>backend/controllers/*"]
PROJECTS["Project Model<br/>backend/models/Project.js"]
UPLOADS["Uploads & Artifacts"]
LLM["LLM Parser<br/>backend/services/llmParser.js"]
GEMINI["Gemini Client<br/>backend/services/geminiClient.js"]
ENGINE_RUNNER["Engine Runner<br/>backend/services/engineRunner.js"]
OPT_PY["Python Engine<br/>backend/engine/main.py"]
PARSER_PY["Python Parser<br/>backend/engine/parser.py"]
CLIENT_MOBILE --> API
CLIENT_WEB --> API
API --> AUTH
API --> PROJECTS
API --> UPLOADS
API --> LLM
LLM --> GEMINI
API --> ENGINE_RUNNER
ENGINE_RUNNER --> OPT_PY
OPT_PY --> PARSER_PY
```

**Diagram sources**
- [lib/main.dart](file://lib/main.dart#L1-L220)
- [frontend/src/App.jsx](file://frontend/src/App.jsx#L1-L60)
- [backend/server.js](file://backend/server.js#L1-L56)
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js#L1-L117)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)
- [backend/services/llmParser.js](file://backend/services/llmParser.js#L1-L170)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js#L1-L73)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/engine/parser.py](file://backend/engine/parser.py#L1-L278)

## Detailed Component Analysis

### Data Ingestion and Canonical Parsing
The backend accepts user-uploaded artifacts (files, text, images) and normalizes them into a canonical JSON schema using Google Generative AI. The LLM parser extracts structured fields, validates presence of required attributes, and records confidence and warnings for review.

```mermaid
sequenceDiagram
participant Client as "Client App"
participant API as "Backend API"
participant Upload as "Uploads"
participant LLM as "LLM Parser"
participant Gemini as "Gemini Client"
Client->>API : "POST /api/projects/ : id/ingest"
API->>Upload : "Store artifact(s)"
API->>LLM : "normalizeArtifacts()"
LLM->>Gemini : "generateContent(prompt + parts)"
Gemini-->>LLM : "raw text response"
LLM-->>API : "canonical JSON + report"
API-->>Client : "Updated project with parsedInput"
```

**Diagram sources**
- [backend/services/llmParser.js](file://backend/services/llmParser.js#L1-L170)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js#L1-L117)

**Section sources**
- [backend/services/llmParser.js](file://backend/services/llmParser.js#L1-L170)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)

### Optimization Pipeline Orchestration
The backend spawns the Python optimization engine, passing the canonical JSON via stdin. The engine precomputes distances, runs multiple genetic solver strategies in parallel, selects the best solution, and returns structured results.

```mermaid
sequenceDiagram
participant API as "Backend API"
participant Runner as "Engine Runner"
participant Py as "Python Engine"
participant Solver as "Genetic Solver"
participant Parser as "Python Parser"
API->>Runner : "runPythonEngine(canonicalJson)"
Runner->>Py : "spawn process"
Py->>Py : "precompute_distance_matrix()"
Py->>Solver : "run_single_solver() × N runs"
Solver-->>Py : "best_solution"
Py->>Parser : "solution_to_json()"
Parser-->>Py : "metrics + routes"
Py-->>Runner : "JSON result"
Runner-->>API : "optimization results"
API-->>Client : "Project.results updated"
```

**Diagram sources**
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js#L1-L73)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/engine/parser.py](file://backend/engine/parser.py#L1-L278)

**Section sources**
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js#L1-L73)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/engine/parser.py](file://backend/engine/parser.py#L1-L278)

### Project Lifecycle and Persistence
Projects encapsulate user requests, artifacts, parsing reports, run state, and results. The backend exposes CRUD operations and dashboard metrics, ensuring data integrity and user-scoped access.

```mermaid
flowchart TD
Start(["Create Project"]) --> Store["Persist Project (requests[], metrics[])"]
Store --> Ingest["Ingest Artifacts"]
Ingest --> Parse["Parse & Validate (LLM)"]
Parse --> Run["Run Optimization (Python Engine)"]
Run --> Results["Save Results & Metrics"]
Results --> View["Fetch Project & Dashboard"]
View --> End(["Optimized Routes Available"])
```

**Diagram sources**
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js#L1-L117)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)

**Section sources**
- [backend/controllers/projectController.js](file://backend/controllers/projectController.js#L1-L117)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)

### Technology Stack Summary
- Flutter (Dart): Mobile application with Riverpod state management, secure storage, file picker, Google Maps integration, and localization support.
- React (JavaScript/JSX): Web application with routing, charts, map overlays, and drag-and-drop file handling.
- Node.js (Express): Backend API with CORS, authentication, file uploads, and orchestration of the Python engine.
- Python: Optimization engine implementing genetic algorithms, parallel execution, and distance computation.
- MongoDB (Mongoose): Persistent storage for users, projects, vehicles, rides, and artifacts.
- Google Maps: Integrated via Flutter and React components for visualization and geolocation.
- Google Generative AI: Used for intelligent parsing of unstructured inputs into canonical JSON.

**Section sources**
- [pubspec.yaml](file://pubspec.yaml#L30-L60)
- [frontend/package.json](file://frontend/package.json#L12-L29)
- [backend/package.json](file://backend/package.json#L9-L23)
- [backend/server.js](file://backend/server.js#L1-L56)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)

## Dependency Analysis
The system exhibits clear separation of concerns:
- Frontends depend on the backend API for all operations.
- The backend depends on MongoDB for persistence and the Python engine for computations.
- The Python engine depends on the canonical schema produced by the LLM parser.

```mermaid
graph LR
Flutter["Flutter App"] --> API["Node.js API"]
React["React App"] --> API
API --> Mongo["MongoDB"]
API --> Engine["Python Engine"]
Engine --> Parser["Python Parser"]
API --> LLM["LLM Parser"]
LLM --> Gemini["Google Generative AI"]
```

**Diagram sources**
- [lib/main.dart](file://lib/main.dart#L1-L220)
- [frontend/src/App.jsx](file://frontend/src/App.jsx#L1-L60)
- [backend/server.js](file://backend/server.js#L1-L56)
- [backend/models/Project.js](file://backend/models/Project.js#L1-L96)
- [backend/services/llmParser.js](file://backend/services/llmParser.js#L1-L170)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)
- [backend/engine/main.py](file://backend/engine/main.py#L1-L193)
- [backend/engine/parser.py](file://backend/engine/parser.py#L1-L278)

**Section sources**
- [DEPLOY.md](file://DEPLOY.md#L138-L169)

## Performance Considerations
- Parallel execution: The Python engine runs multiple solver strategies concurrently to improve solution quality and throughput.
- Distance precomputation: Precomputing the distance matrix reduces redundant calculations during optimization.
- Streaming and timeouts: The Node.js engine runner enforces timeouts and robust JSON extraction to prevent hangs.
- Client-side caching: Flutter and React apps can cache frequently accessed data to reduce network overhead.
- CDN/static hosting: Serve the React app and Flutter web builds from static hosts for faster delivery.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common issues and resolutions:
- Backend not reachable: Verify CORS origins and ensure the API base URL matches the deployed backend.
- Authentication failures: Confirm JWT secret and login flow; check token presence in local storage for the React app and secure storage for Flutter.
- Optimization timeouts: Increase timeout thresholds in the engine runner or reduce input size; validate Python installation and dependencies.
- LLM parsing errors: Ensure the Gemini API key is configured and the prompt aligns with the canonical schema.
- Upload issues: Confirm multer configuration and upload directory permissions; validate MIME types and file sizes.

**Section sources**
- [DEPLOY.md](file://DEPLOY.md#L151-L169)
- [backend/server.js](file://backend/server.js#L26-L41)
- [backend/services/engineRunner.js](file://backend/services/engineRunner.js#L21-L73)
- [backend/services/geminiClient.js](file://backend/services/geminiClient.js#L1-L12)

## Conclusion
Velora Route Optimizer delivers a cohesive, multi-platform solution for AI-powered vehicle routing. By combining intelligent parsing, robust orchestration, and high-performance optimization, it enables organizations to automate complex logistics challenges. The modular architecture, clear APIs, and deployment-friendly design make it suitable for rapid iteration and production-scale rollouts.

[No sources needed since this section summarizes without analyzing specific files]

## Appendices
- Deployment checklist and environment variable mapping are documented in the deployment guide, including steps for Render, alternatives, and client-side build configurations.

**Section sources**
- [DEPLOY.md](file://DEPLOY.md#L1-L169)