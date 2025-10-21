# Citizen Safety Backend - Microservice Architecture

This backend has been architected into a collection of independent, decoupled microservices that communicate over the network. This provides maximum scalability, resilience, and maintainability.

## Architecture Overview

-   **API Gateway**: The single entry point for all client requests. It's a reverse proxy that routes traffic to the appropriate microservice.
-   **Independent Services**: Each service (`auth`, `alerts`, `location`, etc.) is a standalone Node.js/Express application. They can be deployed, scaled, and updated independently.
-   **Communication**:
    -   **Synchronous (Request/Response)**: Services make direct HTTP calls to each other for immediate data needs (e.g., Alerts Service asking Location Service for nearby officers).
    -   **Asynchronous (Events)**: Services publish events to a RabbitMQ message queue to notify other services of state changes (e.g., an alert was created).

## Service Details

| Service                  | Port   | Description                                                                                                                                                                                                                           |
| :----------------------- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API Gateway**          | `3001` | The public-facing entry point. Routes all `/api/*` requests to the correct downstream service. It also handles the initial HTTP `Upgrade` request to establish a WebSocket connection before proxying it.                               |
| **Auth Service**         | `3002` | Manages all user and police officer authentication. Handles registration, login, and updating officer push notification tokens.                                                                                                         |
| **Alerts Service**       | `3003` | Contains the core business logic. It handles the entire lifecycle of an alert (creation, acceptance, resolution, cancellation). It queries the Location Service for nearby officers and publishes events to RabbitMQ to trigger notifications and real-time updates. |
| **Location Service**     | `3004` | Tracks the real-time geographic location of all online police officers. It provides an internal API endpoint for geospatial queries (e.g., "find all officers within 5km") and publishes location updates to RabbitMQ.          |
| **Directions Service**   | `3005` | A simple proxy service that queries the Google Maps Directions API to provide turn-by-turn route data. This isolates the external dependency and API key.                                                                              |
| **WebSocket Service**    | `3006` | Manages all persistent, real-time WebSocket connections with clients. After a client is authenticated, this service listens for broadcast events from RabbitMQ and pushes live data (new alerts, location changes) to the appropriate clients. |
| **Notifications Service**| `N/A`  | A "headless" service with no API. It subscribes to `alert.created` events on the RabbitMQ message queue and is responsible for sending push notifications to targeted officers via the Expo Push Notification service.              |


## Prerequisites

-   Node.js
-   A running RabbitMQ instance (e.g., from [CloudAMQP](https://www.cloudamqp.com/))

## Setup and Installation

1.  **Install All Dependencies**: From this root `server` directory, run the helper script to install dependencies for all services:
    ```bash
    npm run install-all
    ```

2.  **Configure Environment**: Each service, including the API Gateway, is configured via environment variables. Create a `.env` file in the root of each service's directory (e.g., `server/api-gateway/.env`, `server/services/alerts-service/.env`).

    **Example `.env` file for a service (e.g., `alerts-service`):**
    ```ini
    # The URL for the RabbitMQ server
    RABBITMQ_URL=amqps://user:password@hostname.rmq.cloudamqp.com/vhost

    # Port for this specific service to run on
    PORT=3003

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

7.  **Start the Notifications Service:**
    ```bash
    cd services/notifications-service && npm start
    ```

Your client application should be configured to connect to the **API Gateway's URL** (e.g., `http://localhost:3001`). The gateway will handle routing all requests to the correct backend service.
