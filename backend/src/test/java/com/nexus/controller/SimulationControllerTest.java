package com.nexus.controller;

import com.nexus.model.IncidentUpdate;
import com.nexus.model.Vehicle;
import com.nexus.model.VehicleType;
import com.nexus.simulation.RoadGraph;
import com.nexus.simulation.SimulationEngine;
import com.nexus.simulation.TrafficMode;
import com.nexus.websocket.VehicleBroadcaster;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class SimulationControllerTest {

    private SimulationEngine engine;
    private VehicleBroadcaster broadcaster;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        engine = Mockito.mock(SimulationEngine.class);
        broadcaster = Mockito.mock(VehicleBroadcaster.class);
        mvc = MockMvcBuilders.standaloneSetup(new SimulationController(engine, broadcaster)).build();
    }

    @Test
    void boundsAre204UntilTheGraphIsLoaded() throws Exception {
        mvc.perform(get("/api/simulation/bounds")).andExpect(status().isNoContent());

        when(engine.getGraphBounds()).thenReturn(new RoadGraph.Bounds(46.0, 46.1, -1.2, -1.1));
        mvc.perform(get("/api/simulation/bounds"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minLat").value(46.0))
                .andExpect(jsonPath("$.maxLon").value(-1.1));
    }

    @Test
    void statusExposesTheEngineState() throws Exception {
        when(engine.getVehicleCount()).thenReturn(2000);
        when(engine.getSpeedMultiplier()).thenReturn(1.5);
        when(engine.isPaused()).thenReturn(true);

        mvc.perform(get("/api/simulation/status"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.vehicleCount").value(2000))
                .andExpect(jsonPath("$.speedMultiplier").value(1.5))
                .andExpect(jsonPath("$.paused").value(true));
    }

    @Test
    void pauseResumeAndSpeedDelegateToTheEngine() throws Exception {
        mvc.perform(post("/api/simulation/pause")).andExpect(status().isOk());
        mvc.perform(post("/api/simulation/resume")).andExpect(status().isOk());
        mvc.perform(post("/api/simulation/speed").param("multiplier", "2.5")).andExpect(status().isOk());

        verify(engine).pause();
        verify(engine).resume();
        verify(engine).setSpeedMultiplier(2.5);
    }

    @Test
    void changingTheFleetSizePushesAKeyframeImmediately() throws Exception {
        mvc.perform(post("/api/simulation/vehicles").param("count", "5000")).andExpect(status().isOk());

        verify(engine).setVehicleCount(5000);
        verify(broadcaster).pushImmediateKeyframe();
    }

    @Test
    void trafficOverrideParsesModesCaseInsensitively() throws Exception {
        mvc.perform(post("/api/simulation/traffic/override").param("mode", "night")).andExpect(status().isOk());
        verify(engine).setTrafficOverride(TrafficMode.NIGHT);
    }

    @Test
    void trafficOverrideWithoutOrWithBadModeClearsTheOverride() throws Exception {
        mvc.perform(post("/api/simulation/traffic/override")).andExpect(status().isOk());
        mvc.perform(post("/api/simulation/traffic/override").param("mode", "bogus")).andExpect(status().isOk());

        verify(engine, Mockito.times(2)).setTrafficOverride(null);
    }

    @Test
    void unknownVehicleRouteIs404() throws Exception {
        mvc.perform(get("/api/simulation/vehicles/nope/route")).andExpect(status().isNotFound());
    }

    @Test
    void incidentDefaultsAreAppliedAndClickIsSnappedToARoad() throws Exception {
        when(engine.nearestVehicle(anyDouble(), anyDouble(), anyDouble())).thenReturn(null);
        when(engine.snapToNearestRoad(46.15, -1.15)).thenReturn(new double[]{46.1501, -1.1502});

        mvc.perform(post("/api/simulation/incidents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"lat\":46.15,\"lon\":-1.15}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.type").value("accident"))
                .andExpect(jsonPath("$.severity").value(2))
                .andExpect(jsonPath("$.lat").value(46.1501))
                .andExpect(jsonPath("$.label").value("accident (manuel)"));

        ArgumentCaptor<IncidentUpdate> added = ArgumentCaptor.forClass(IncidentUpdate.class);
        verify(engine).addManualIncident(added.capture());
        assertTrue(added.getValue().id().startsWith("man-"));
        verify(engine, never()).wreckVehicle(any(), anyLong());
    }

    @Test
    void severityAndDurationAreClamped() throws Exception {
        when(engine.snapToNearestRoad(anyDouble(), anyDouble())).thenReturn(new double[]{46.1, -1.1});

        long before = System.currentTimeMillis();
        mvc.perform(post("/api/simulation/incidents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"closure\",\"severity\":9,\"durationMs\":1,\"lat\":46.1,\"lon\":-1.1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.severity").value(3));

        ArgumentCaptor<IncidentUpdate> added = ArgumentCaptor.forClass(IncidentUpdate.class);
        verify(engine).addManualIncident(added.capture());
        long duration = added.getValue().expiresAtMs() - before;
        assertTrue(duration >= 5_000 && duration < 6_000, "duration clamped to the 5 s minimum, was " + duration);
    }

    @Test
    void droppingAnAccidentNearAVehicleWrecksIt() throws Exception {
        Vehicle car = new Vehicle("car-42", VehicleType.CAR);
        car.setLatitude(46.2);
        car.setLongitude(-1.2);
        when(engine.nearestVehicle(anyDouble(), anyDouble(), anyDouble())).thenReturn(car);

        mvc.perform(post("/api/simulation/incidents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"lat\":46.2001,\"lon\":-1.2001,\"durationMs\":30000}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lat").value(46.2))
                .andExpect(jsonPath("$.label").value("accident : car-42"));

        verify(engine).wreckVehicle(eq("car-42"), eq(30_000L));
        verify(engine, never()).snapToNearestRoad(anyDouble(), anyDouble());
        assertEquals(1, Mockito.mockingDetails(engine).getInvocations().stream()
                .filter(i -> i.getMethod().getName().equals("addManualIncident")).count());
    }
}
