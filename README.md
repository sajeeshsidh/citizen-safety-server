# Citizen Safety Backend - Microservice Architecture

This backend has been architected into a collection of independent, decoupled microservices that communicate over the network. This provides maximum scalability, resilience, and maintainability.

## Architecture Overview

-   **API Gateway**: The single entry point for all client requests. It's a reverse proxy that routes traffic to the appropriate microservice.
-   **Independent Services**: Each service (`auth`, `alerts`, `location`, etc.) is a standalone Node.js/Express application. They can be deployed, scaled, and updated independently.
-   **Communication**:
    -   **Synchronous (Request/Response)**: Services make direct HTTP calls to each other for immediate data needs (e.g., Alerts Service asking AI Service to categorize an alert).
    -   **Asynchronous (Events)**: Services publish events to a RabbitMQ message queue to notify other services of state changes (e.g., an alert was created).

## Service Details

| Service                  | Port   | Description                                                                                                                                                                                                                           |
| :----------------------- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API Gateway**          | `3001` | The public-facing entry point. Routes all `/api/*` requests to the correct downstream service. It also handles the initial HTTP `Upgrade` request to establish a WebSocket connection before proxying it.                               |
| **Auth Service**         | `3002` | Manages authentication for all roles (citizens, police, firefighters). Handles registration, login, and updating officer push notification tokens.                                                                                     |
| **Alerts Service**       | `3003` | Contains the core business logic. It orchestrates alert creation by first calling the AI Service to get a category, then querying the Location Service for appropriate responders. It publishes events to RabbitMQ.                       |
| **Location Service**     | `3004` | Tracks the real-time geographic location of all responders. It provides an internal API endpoint for geospatial queries based on emergency category (e.g., "find all firefighters within 5km").                                     |
| **Directions Service**   | `3005` | A simple proxy service that queries the Google Maps Directions API to provide turn-by-turn route data. This isolates the external dependency and API key.                                                                              |
| **WebSocket Service**    | `3006` | Manages all persistent, real-time WebSocket connections with clients. After a client is authenticated, this service listens for broadcast events from RabbitMQ and pushes live data (new alerts, location changes) to clients.            |
| **AI Analysis Service**  | `3007` | An intelligent service that uses the Gemini API to analyze the text of an alert. It classifies the emergency into a predefined category (e.g., 'Law & Order', 'Fire & Rescue') and returns this category to the Alerts Service. |
| **Notifications Service**| `N/A`  | A "headless" service with no API. It subscribes to `alert.created` events on the RabbitMQ message queue and is responsible for sending push notifications to targeted responders via the Expo Push Notification service.              |


## Prerequisites

-   Node.js
-   A running RabbitMQ instance (e.g., from [CloudAMQP](https://www.cloudamqp.com/))
-   A Google Gemini API Key.

## Setup and Installation

1.  **Install All Dependencies**: From this root `server` directory, run the helper script to install dependencies for all services:
    ```bash
    npm run install-all
    ```

2.  **Configure Environment**: Each service is configured via environment variables. Create a `.env` file in the root of each service's directory (e.g., `server/api-gateway/.env`, `server/services/ai-analysis-service/.env`).

    **Example `.env` file for `ai-analysis-service`:**
    ```ini
    # The URL for the RabbitMQ server
    RABBITMQ_URL=amqps://user:password@hostname.rmq.cloudamqp.com/vhost
    API_KEY=YOUR_GEMINI_API_KEY

    # Port for this specific service to run on
    PORT=3007

    # URLs of OTHER services (only needed by services that make direct calls)
    LOCATION_SERVICE_URL=http://localhost:3004
    ```

    **Example `.env` file for `api-gateway`:**
    ```ini
    PORT=3001
    AUTH_SERVICE_URL=http://localhost:3002
    ALERTS_SERVICE_URL=http://localhost:3003
    LOCATION_SERVICE_URL=http://localhost:3004
    DIRECTIONS_SERVICE_URL=http://localhost:3005
    WEBSOCKET_SERVICE_URL=ws://localhost:3006
    AI_ANALYSIS_SERVICE_URL=http://localhost:3007
    ```

## Running the Services

You must start each service independently in its own terminal window. The startup order does not matter.

1.  **Start the API Gateway:**
    ```bash
    cd api-gateway && npm start
    ```

2.  **Start the Auth Service:**
    ```bash
    cd services/auth-service && npm start
    ```

3.  **Start the Alerts Service:**
    ```bash
    cd services/alerts-service && npm start
    ```

4.  **Start the Location Service:**
    ```bash
    cd services/location-service && npm start
    ```

5.  **Start the Directions Service:**
    ```bash
    cd services/directions-service && npm start
    ```
    
6.  **Start the WebSocket Service:**
    ```bash
    cd services/websocket-service && npm start
    ```

7.  **Start the AI Analsysis Service:**
    ```bash
    cd services/ai-analysis-service && npm start
    ```

8.  **Start the Notifications Service:**
    ```bash
    cd services/notifications-service && npm start
    ```

Your client application should be configured to connect to the **API Gateway's URL** (e.g., `http://localhost:3001`). The gateway will handle routing all requests to the correct backend service.
