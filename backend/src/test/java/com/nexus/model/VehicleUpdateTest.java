package com.nexus.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class VehicleUpdateTest {

    @Test
    void numericFieldsAreRoundedToRendererPrecision() {
        VehicleUpdate v = new VehicleUpdate("v1", 46.123456789, -1.987654321, 42.449, 89.6, VehicleType.CAR, false);
        assertEquals(46.12346, v.lat(), 1e-9);
        assertEquals(-1.98765, v.lon(), 1e-9);
        assertEquals(42.4, v.speed(), 1e-9);
        assertEquals(90.0, v.direction(), 1e-9);
    }

    @Test
    void wreckedFlagIsOmittedFromJsonWhenFalse() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String normal = mapper.writeValueAsString(new VehicleUpdate("v1", 46, -1, 10, 0, VehicleType.BUS, false));
        String wrecked = mapper.writeValueAsString(new VehicleUpdate("v1", 46, -1, 0, 0, VehicleType.BUS, true));
        assertFalse(normal.contains("wrecked"));
        assertTrue(wrecked.contains("\"wrecked\":true"));
    }
}
