# ── Build ───────────────────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package -DskipTests

# ── Run ─────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home nexus
WORKDIR /app
COPY --from=build /build/target/nexus-backend-*.jar app.jar
# OSM / IRIS data is not baked in (hundreds of MB): mount it at /app/data.
RUN mkdir -p data/maps data/iris && chown -R nexus:nexus /app
USER nexus
EXPOSE 8080
ENV JAVA_OPTS="-Xms512m -Xmx2g"
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:8080/api/simulation/status || exit 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
