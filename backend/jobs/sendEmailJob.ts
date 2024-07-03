import { Queue, Worker, Job, ConnectionOptions } from "bullmq";
import { defaultQueueConfig, redisConnection } from "../config/queue";
import { sendEmail } from "../config/mailer";

export const emailQueueName = "email-queue";

interface EmailJobData {
  to: string;
  subject: string;
  text: string;
}

export const emailQueue = new Queue<EmailJobData>(emailQueueName, {
  connection: redisConnection,
  defaultJobOptions: defaultQueueConfig,
});

export const handler = new Worker<EmailJobData>(
  emailQueueName,
  async (job: Job<EmailJobData>) => {
    console.log("The email worker data is", job.data);
    const data = job.data;
    await sendEmail({ to: data.to, subject: data.subject, text: data.text });
    console.log("The valaue of to is", data.to);
    console.log("The valaue of subject is", data.subject);
    console.log("The valaue of text is", data.text);
  },
  { connection: redisConnection }
);

handler.on("completed", (job: Job) => {
  console.log(`The job ${job.id} is completed`);
});

handler.on("failed", (job: any, err: Error) => {
  console.log(`The job ${job.id} failed with error: ${err.message}`);
});
