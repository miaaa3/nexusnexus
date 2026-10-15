package com.nexus;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Boots the whole Spring context. With no .osm file on disk the engine runs
 * without a road graph, which is exactly what CI has (maps are gitignored).
 */
@SpringBootTest(properties = {
        "nexus.simulation.vehicle-count=10",
        "nexus.simulation.local-file=data/maps/does-not-exist.osm",
        "nexus.simulation.iris-local-file=data/iris/does-not-exist.geojson"
})
class NexusApplicationTests {

    @Autowired
    ApplicationContext context;

    @Test
    void contextLoads() {
        assertNotNull(context);
    }
}
