import express, { Request, Response } from "express";
import session, { SessionData } from "express-session";
import passport from "passport";
import cors from "cors";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import axios from "axios";
import { emailQueue, emailQueueName } from "./jobs/sendEmailJob";
import { sendEmail } from "./config/mailer";
const bodyParser = require("body-parser");
const process = require("process");
const { Configuration, OpenAIApi } = require("openai");
const { google } = require("googleapis");
const { OAuth2 } = google.auth;
const dotenv = require("dotenv");

dotenv.config();
const tokenStore = {
  access_token: "",
  refresh_token: "",
  scope: "",
  token_type: "",
};

interface User {
  id: string;
  accessToken: string;
  refreshToken?: string;
  profile: Profile;
}

const oAuth2Client = new OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  "http://localhost:5173/auth/callback/google"
);

const tokens = {
  access_token: process.env.ACCESS_TOKEN,
  refresh_token: process.env.REFRESH_TOKEN,
  scope: process.env.SCOPES,
  token_type: "Bearer",
};
oAuth2Client.setCredentials(tokens);

// *************************************************************************

oAuth2Client.on("tokens", (tokens: any) => {
  if (tokens.refresh_token) {
    console.log("Refresh token:", tokens.refresh_token);
  }
  console.log("Access token:", tokens.access_token);
});

// *************************************************************************

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// *************************************************************************

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "default_session_secret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(cors());
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      callbackURL: "http://localhost:5173/auth/callback/google",
      passReqToCallback: true,
    },

    function (
      req: Request,
      accessToken: string,
      refreshToken: string,
      profile: Profile,
      done: (error: any, user?: any) => void
    ) {
      const user: User = {
        id: profile.id,
        accessToken,
        refreshToken,
        profile,
      };

      done(null, user);
    }
  )
);

passport.serializeUser(function (user: any, done: any) {
  done(null, user);
});

passport.deserializeUser((obj: any, done) => {
  done(null, obj as User);
});

app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    res.redirect("/");
  }
);

app.get("/auth/google", (req, res) => {
  const { CLIENT_ID, REDIRECT_URI } = process.env;
  const scope =
    "https://www.googleapis.com/auth/gmail.readonly+https://www.googleapis.com/auth/gmail.modify+https://www.googleapis.com/auth/drive+https://www.googleapis.com/auth/gmail.labels";
  const responseType = "code";
  const accessType = "offline";

  const authUrl = `https://accounts.google.com/o/oauth2/auth?scope=${scope}&response_type=${responseType}&access_type=${accessType}&redirect_uri=${REDIRECT_URI}&client_id=${CLIENT_ID}`;

  res.redirect(authUrl);
});

app.get("/auth/callback/google", async (req, res) => {
  console.log("Query parameters:", req.query);
  const { code } = req.query;
  console.log("Received authorization code:", code);

  if (!code) {
    console.error("Authorization code not found");
    return res.status(400).send("Authorization code not found");
  }

  try {
    console.log("Exchanging authorization code for tokens...");

    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: "authorization_code",
      },
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, refresh_token, scope, token_type } =
      tokenResponse.data;

    console.log("Access Token:", access_token);
    console.log("Refresh Token:", refresh_token);
    console.log("Scope:", scope);
    console.log("Token Type:", token_type);

    tokenStore.access_token = access_token;
    tokenStore.refresh_token = refresh_token;
    tokenStore.scope = scope;
    tokenStore.token_type = token_type;

    console.log("Token response data stored in tokenStore.");

    res.send(
      "OAuth 2.0 flow completed successfully. You can close this window."
    );
  } catch (error: any) {
    if (error.response) {
      console.error("Error response data:", error.response.data);
      console.error("Error response status:", error.response.status);
      console.error("Error response headers:", error.response.headers);
    } else {
      console.error("Error exchanging code for tokens:", error.message);
    }
    res.status(500).send("Failed to complete OAuth 2.0 flow.");
  }
});

async function classifyEmail(subject: string, body: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const url = "https://api.openai.com/v1/chat/completions";

  const data = {
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "Classify the email content as Interested, Not Interested, or More Information.",
      },
      {
        role: "user",
        content: `Subject: ${subject}\n\nBody: ${body}`,
      },
    ],
    max_tokens: 50,
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("Error with Axios request:", error.response?.data);
    } else {
      console.error("Error:", error);
    }
    throw error;
  }
}

app.get("/processEmail", async (req, res) => {
  try {
    const emailResponse = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
    });
    const emails = emailResponse.data.messages;

    if (!emails) {
      res.send("No unread emails found");
      return;
    }

    for (const email of emails) {
      const emailData = await gmail.users.messages.get({
        userId: "me",
        id: email.id,
      });
      const subject =
        emailData.data.payload?.headers?.find(
          (header: any) => header.name === "Subject"
        )?.value || "";
      const body = emailData.data.snippet || "";

      const classification = await classifyEmail(subject, body);
      await applyLabelToEmail(email.id, classification);
    }

    res.send("Emails processed and labeled successfully");
  } catch (error) {
    console.error("Error reading and categorizing emails:", error);
    res.status(500).send("Error reading and categorizing emails");
  }
});

app.get("/createLabels/:email", async (req: Request, res: Response) => {
  const { email } = req.params;
  const accessToken =
    "ya29.a0AXooCgtE1ij_1SjR2tsoBgYQbFr7LxmkqsJRdt9kXMbN2xe2lNGJz8Xu1jlxOXfFxGGIuaZ-2OdDz2RK6AN0QpF94b8ZQj7dTTLQc9yGUrk1oa5sC0tst3EDBGelpQtx_G6yBneL1vDqDECnAXXazl49GU_aXZNqje1DaCgYKAeASARESFQHGX2Mi5T_MHTQR62VPj5y_mjjyTg0171";

  try {
    const tokenInfoUrl = `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`;
    const tokenInfoResponse = await axios.get(tokenInfoUrl);

    const labels: string[] = [
      "Interested",
      "Not Interested",
      "More Information",
    ];

    const createLabelUrl = `https://gmail.googleapis.com/gmail/v1/users/${email}/labels`;
    const createLabelResponses: any[] = [];

    for (const label of labels) {
      const labelData = {
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
        name: label,
      };

      const createLabelResponse = await axios.post(createLabelUrl, labelData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      createLabelResponses.push(createLabelResponse.data);

      res.json(createLabelResponses);
    }
  } catch (error: any) {
    res.status(500).send(error.message);
    console.log(`Can't create labels:`, error.message);
  }
});

app.get("/getMails/:email", async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    const accessToken = process.env.access_token;
    const tokenInfoUrl = `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`;
    const tokenInfoResponse = await axios.get(tokenInfoUrl);

    if (tokenInfoResponse.data.email === email) {
      const gmailInboxUrl = `https://mail.google.com/mail/u/0?maxResults=2`;
      res.redirect(gmailInboxUrl);
    } else {
      res
        .status(403)
        .send("Access token does not match the provided email address");
    }
  } catch (error: any) {
    res.status(500).send(error.message);
    console.log(
      `Can't verify access token or redirect to inbox:`,
      error.message
    );
  }
});

const getUserEmail = async (accessToken: any) => {
  try {
    oAuth2Client.setCredentials({
      access_token: accessToken,
    });

    const oauth2 = google.oauth2({
      auth: oAuth2Client,
      version: "v2",
    });

    const userInfoResponse = await oauth2.userinfo.get();
    return userInfoResponse.data.email;
  } catch (error) {
    console.error("Error fetching user email:", error);
    throw error;
  }
};

const getOrCreateLabelId = async (labelName: any) => {
  try {
    const labelsRes = await gmail.users.labels.list({
      userId: "me",
    });
    const labels = labelsRes.data.labels || [];

    let label = labels.find((l: any) => l.name === labelName);

    if (!label) {
      const newLabelRes = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      label = newLabelRes.data;
    }
    return "LABEL_ID";
  } catch (error) {
    console.error(`Error getting or creating label: ${labelName}`, error);
    throw error;
  }
};

const applyLabelToEmail = async (messageId: any, labelId: any) => {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
      },
    });
    console.log(`Label applied to email ${messageId}`);
  } catch (error) {
    console.error(`Error applying label to email: ${messageId}`, error);
  }
};

const determineCategory = (responseContent: any) => {
  if (responseContent.includes("Interested")) {
    return "Interested";
  } else if (responseContent.includes("Not Interested")) {
    return "Not Interested";
  } else {
    return "More Information";
  }
};

const fetchEmailContent = async (auth: any, messageId: string) => {
  try {
    const gmail = google.gmail({ version: "v1", auth }); // Ensure you have initialized auth properly
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const payload = res.data.payload;
    const headers = payload?.headers;
    const emailContent = res.data.snippet;

    let fromEmail = null;
    if (headers) {
      const fromHeader = headers.find((header: any) => header.name === "From");
      if (fromHeader) {
        const match = fromHeader.value.match(/<(.+)>/);
        fromEmail = match ? match[1] : fromHeader.value;
      }
    }

    return { emailContent, fromEmail };
  } catch (error) {
    console.error(`Error fetching email content: ${messageId}`, error);
    throw error;
  }
};

let emails: any[] = [];
app.get("/readAndCategorizeEmails", async (req: Request, res: Response) => {
  try {
    const emailsRes = await gmail.users.messages.list({
      userId: "me",
      q: "category:primary",
      maxResults: 2,
    });

    const messages = emailsRes.data.messages || [];

    const categorizedEmails = await Promise.all(
      messages.map(async (email: any) => {
        const messageId = email.id;
        const emailContent = await fetchEmailContent(oAuth2Client, messageId);
        console.log("Email content is", emailContent);

        const openai = new OpenAIApi(configuration);
        const classificationResponse = await openai.createChatCompletion({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content:
                "Classify the email content as Interested, Not Interested, or More Information.",
            },
            { role: "user", content: emailContent.emailContent },
          ],
          max_tokens: 50,
        });

        const classifiedCategory = determineCategory(
          classificationResponse.data.choices[0].message.content
        );

        const labelIdMap = {
          Interested: await getOrCreateLabelId("Interested"),
          "Not Interested": await getOrCreateLabelId("Not Interested"),
          "More Information": await getOrCreateLabelId("More Information"),
        };

        const labelId: any = labelIdMap[classifiedCategory];
        console.log("to check what we are getting", messageId, labelId);
        await applyLabelToEmail(messageId, labelId);
        console.log(`Label applied to email ${messageId}`);

        if (classifiedCategory === "Interested") {
          console.log("Email classified as Interested");
          const { fromEmail } = await fetchEmailContent(
            oAuth2Client,
            messageId
          );
          emails.push(fromEmail);
        }

        console.log("The list of emails sent is", emails);
        return {
          messageId,
          category: classifiedCategory,
          link: `https://mail.google.com/mail/u/0/#inbox/${messageId}`,
        };
      })
    );

    console.log("Final list of emails:", emails);
    res.status(200).send("The mail have been categorised");
  } catch (error) {
    console.error("Error reading and categorizing emails:", error);
    res.status(500).send("Error reading and categorizing emails");
  }
});

app.get("/sendMail", async (req: Request, res: Response) => {
  try {
    let payload: any[] = [];
    console.log("Pushing emails into the payload array");
    console.log("emails we got from the above api is :", emails);
    emails.forEach((e: any) => {
      payload.push({
        to: e as string,
        subject: ".",
        text: ".",
      });
    });

    console.log("The value of payload is", payload);

    console.log("Finished pushing emails into the payload array");

    console.log("Adding emails to the job queue");

    await Promise.all(
      payload.map(async (jobData: any) => {
        try {
          await emailQueue.add(emailQueueName, jobData);
          console.log(`Email added to job queue for ${jobData.to}`);

          await sendEmail(jobData);
          console.log(`Email sent successfully to ${jobData.to}`);
        } catch (error: any) {
          console.error(
            `Error sending email to ${jobData.to}: ${error.message}`
          );
          throw error;
        }
      })
    );

    console.log("Finished adding emails to the job queue");

    return res.json({ status: 200, message: "Jobs added successfully" });
  } catch (error) {
    console.error("Error sending emails:", error);
    return res
      .status(500)
      .json({ status: 500, message: "Could not send emails" });
  }
});

const PORT = 8000;

app.listen(PORT, () => {
  console.log(`Running on PORT ${PORT}`);
});
