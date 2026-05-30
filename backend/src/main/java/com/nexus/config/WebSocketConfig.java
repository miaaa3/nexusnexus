package com.nexus.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

/**
 * STOMP-over-SockJS configuration.
 *
 * <p>At 15 K+ vehicles every broadcast is multi-megabyte JSON. Spring's defaults
 * are sized for chat traffic (512 KB send buffer, 64 KB STOMP message), so the
 * first big frame kills the session with:
 * <pre>Buffer size N bytes for session ... exceeds the allowed limit 524288</pre>
 * We raise three limits in concert:
 * <ul>
 *   <li>{@code setMessageSizeLimit} — STOMP frame ceiling (incoming + outgoing)</li>
 *   <li>{@code setSendBufferSizeLimit} — per-session queued outbound bytes</li>
 *   <li>{@code setSendTimeLimit} — how long a slow client may hold the buffer</li>
 * </ul>
 * Combined with the compact wire format in {@code VehicleUpdate} this keeps
 * even 20 K-vehicle frames well under the new ceiling.
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    /** Single STOMP frame ceiling — must hold one full vehicle snapshot. */
    private static final int MESSAGE_SIZE_LIMIT     = 16 * 1024 * 1024;   // 16 MB
    /** Per-session outbound queue ceiling — drops sessions only if they fall far behind. */
    private static final int SEND_BUFFER_SIZE_LIMIT =  8 * 1024 * 1024;   //  8 MB
    /** Max time a slow client may hold the buffer before being disconnected. */
    private static final int SEND_TIME_LIMIT_MS     = 20_000;

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic");
        registry.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration r) {
        r.setMessageSizeLimit(MESSAGE_SIZE_LIMIT);
        r.setSendBufferSizeLimit(SEND_BUFFER_SIZE_LIMIT);
        r.setSendTimeLimit(SEND_TIME_LIMIT_MS);
    }
}
