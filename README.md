# xrpl-gpc-token (Goldstake)

This is the backend service for Goldstake, a DeFi application on the XRP Ledger that provides token swap and staking functionalities. It is designed as an off-chain processing engine that listens and reacts to on-chain XRPL events.

## Token Information

- XRPL Testnet
  
  - **RLD**: `rs1BTRfAwp4KpBaPuND8WoESDT3JzQoxUq`
  
  - **GPC**: `r4WfXjE9qGrPvRgTWBbp8CT7cb5Ur7iX6Q`
  
  - **Swap Pool**: `rQU2LkjttEmWyY56jgmGXZND5yriWihZMW`

  - **Stake Pool**: `r9H4gzDaxtsB41iMYbUDNtLHjCeBZH88kb`

## 🚀 Overview

Goldstake allows users to swap between `RLUSD` and `GPC` tokens and stake `GPC` to earn rewards in `RLUSD`. This backend serves as the central nervous system for the application. It operates by:

1.  **Listening** for real-time, on-chain transactions sent to designated service wallets.
2.  **Processing** these transactions according to a set of business rules (e.g., calculating swap amounts, updating stake balances).
3.  **Executing** payout transactions (swapped tokens, staking rewards) from the service wallets back to the user.

The entire architecture is designed to be robust, scalable, and secure, providing a seamless experience for users interacting via the Xaman (xApp) client.

## ✨ Core Features

  * **Token Swaps:** Bi-directional swaps between `RLUSD` and `GPC`.
  * **GPC Staking:** Stake `GPC` tokens to earn `RLUSD` rewards based on a fixed APR.
  * **Secure Actions:** User-initiated claims and unstakes are authorized via cryptographic signatures using the Xaman wallet, ensuring user funds are never at risk.
  * **Asynchronous Processing:** Utilizes a job queue system to handle all payouts, ensuring the system remains responsive and resilient to network latency.
  * **Real-time Event Driven:** No polling. The backend subscribes directly to ledger events for immediate processing.

## 🏛️ Architecture

The Goldstake backend is built upon an **off-chain processing architecture**. It cleanly separates the roles of the on-chain ledger and the off-chain application server. The XRPL acts as the secure **settlement layer**, while our backend serves as the flexible **computation and application layer**.

### Core Concepts

  * **Event-Driven from the Ledger:** The backend subscribes to the `Swap Pool` and `Stake Pool` XRPL accounts. Validated on-chain transactions are ingested as immutable events that trigger the application's business logic.
  * **Decoupled Execution via Job Queue:** When a payout is required (e.g., after a swap deposit), the system doesn't execute it immediately. Instead, a job is added to a persistent queue in our `MySQL` database. Asynchronous background workers process this queue, decoupling the API from the execution logic and enhancing fault tolerance.
  * **Off-Chain State Computation:** Complex logic, like calculating staking rewards over time, is handled entirely off-chain. This keeps our on-chain operations simple and cost-effective while allowing for sophisticated features.
  * **On-Chain Asset Segregation:** We use two distinct XRPL accounts—a `Swap Pool` for liquidity and a `Stake Pool` for staking assets. This separation simplifies accounting and mitigates risk by isolating funds based on their purpose.

### System Components

1.  **Settlement Layer (`XRPL`)**

      * The source of truth for all asset transfers.
      * Provides real-time events via WebSocket subscriptions.

2.  **Application Layer (`Node.js / Fastify`)**

      * **API Gateway:** A high-performance API for the client to fetch data (e.g., APR, balances) and initiate actions (e.g., request a signature).
      * **Event Listener:** A persistent service that listens for new transactions on the pool accounts.
      * **Task Processors:** Cron-based background workers that execute pending jobs from the queue (swaps, claims, unstakes).

3.  **Persistence Layer (`MySQL`)**

      * **State Database:** Stores user stake information, transaction history, etc.
      * **Job Queue:** The `swap_requests`, `claim_requests`, and `unstake_requests` tables act as a durable job queue.

### Key Workflows

#### Workflow 1: Token Swap & Stake (On-Chain Triggered)

*This flow is reactive. The user acts on-chain, and the backend reacts.*

1.  **User ➡️ XRPL:** A user sends `RLUSD` (for a swap) or `GPC` (for staking) to the appropriate Pool address.
2.  **XRPL ➡️ Backend:** The `Event Listener` detects the validated transaction.
3.  **Backend Logic:**
      * **For Staking:** The backend immediately updates the user's staked balance in the `stakes` table.
      * **For Swaps:** The backend calculates the payout and adds a job to the `swap_requests` queue with `status: 'pending'`.
4.  **Backend ➡️ XRPL:** An asynchronous `Task Processor` picks up the pending swap job, and sends the corresponding tokens from the service wallet back to the user.

#### Workflow 2: Reward Claim & Unstake (Off-Chain Authorized)

*This flow is proactive. The user authorizes an action off-chain, and the backend executes it on-chain.*

1.  **Client ➡️ Backend:** The user clicks "Claim" or "Unstake" in the app. The client calls the `/request-signature` API.
2.  **Backend ➡️ Xaman:** The backend generates a `SignIn` payload for the user to sign.
3.  **User ➡️ Xaman:** The user signs the transaction in their Xaman wallet.
4.  **Client ➡️ Backend:** The client calls the `/verify-signature` API with the payload `uuid`.
5.  **Backend Logic:** The backend verifies the signature with Xaman. On success, it adds a job to the `claim_requests` or `unstake_requests` queue. For unstakes, it also immediately deducts the amount from the user's staked balance to prevent double-spending.
6.  **Backend ➡️ XRPL:** An asynchronous `Task Processor` picks up the job and sends the `RLUSD` (rewards) or `GPC` (unstaked amount) to the user.

## 🛠️ Technology Stack

  * **Backend Framework:** [Node.js](https://nodejs.org/), [Fastify](https://www.fastify.io/)
  * **Database:** [MySQL](https://www.mysql.com/)
  * **XRPL Interaction:** [xrpl.js](https://www.google.com/search?q=https://xrpl.org/docs/libraries/javascript/)
  * **Signature Authentication:** [Xaman (Xumm) API](https://www.google.com/search?q=https://xumm.readme.io/reference/get-started)
  * **Job Scheduling:** [fastify-cron](https://www.npmjs.com/package/fastify-cron)
  * **Concurrency Control:** [async-mutex](https://www.npmjs.com/package/async-mutex)

## ⚙️ Getting Started

### Prerequisites

  * Node.js (v18 or higher)
  * MySQL Server
  * An active `.env` file with all required keys (see `.env.example`)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/CrederLabs/xrpl-gpc-token.git
cd xrpl-gpc-token

# 2. Install dependencies
npm install
```

### Running the Server

```bash
# Start the server in development mode
npm run dev

# Start the server in production mode
npm start
```
