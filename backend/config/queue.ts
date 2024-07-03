import { ConnectionOptions } from "bullmq";

const redisHost: string = process.env.REDIS_HOST || "localhost";
const redisPort: number = process.env.REDIS_PORT
  ? parseInt(process.env.REDIS_PORT, 10)
  : 6379;

if (isNaN(redisPort)) {
  throw new Error("Invalid REDIS_PORT value");
}

export const redisConnection: ConnectionOptions = {
  host: redisHost,
  port: redisPort,
};

export const defaultQueueConfig = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 5000,
  },
};
