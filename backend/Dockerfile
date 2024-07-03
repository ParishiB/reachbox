# Use the official Node.js image as the base image
FROM node:16-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Build the TypeScript code (if needed)
RUN npm run build

# Expose the port your application runs on
EXPOSE 8000

# Command to run your application
CMD ["npm", "start"]
