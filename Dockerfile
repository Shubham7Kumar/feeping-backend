
FROM node:22-bookworm-slim

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY --chown=node:node . .

# Run as non-root user
USER node

EXPOSE 5000

CMD ["npm", "start"]