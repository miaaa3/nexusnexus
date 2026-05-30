package com.nexus.service;

import com.nexus.model.SimulationFrame;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Circular buffer that retains the last MAX_FRAMES simulation frames.
 *
 * Performance notes:
 * - Fixed-size Object[] ring: no reallocations after warmup
 * - ReadWriteLock: many readers (REST queries) blocked only during brief writes
 * - Queries by time range are O(k) where k = frames in [start, end]
 */
@Slf4j
@Service
public class FrameRecorder {

    // 600 frames @ 10 Hz → 60 seconds of history
    private static final int MAX_FRAMES = 600;

    private final SimulationFrame[] ring = new SimulationFrame[MAX_FRAMES];
    private int head = 0;          // next write position
    private int size = 0;          // number of valid entries
    private final ReadWriteLock lock = new ReentrantReadWriteLock();

    /** Record a new frame — called by VehicleBroadcaster after each tick. */
    public void record(SimulationFrame frame) {
        lock.writeLock().lock();
        try {
            ring[head] = frame;
            head = (head + 1) % MAX_FRAMES;
            if (size < MAX_FRAMES) size++;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Return frames whose timestamp falls within [fromMs, toMs].
     * Returns an empty list if the range is outside the buffer window.
     */
    public List<SimulationFrame> query(long fromMs, long toMs) {
        lock.readLock().lock();
        try {
            List<SimulationFrame> result = new ArrayList<>();
            int count = size;
            int start = (head - count + MAX_FRAMES) % MAX_FRAMES;

            for (int i = 0; i < count; i++) {
                SimulationFrame f = ring[(start + i) % MAX_FRAMES];
                if (f != null && f.timestamp() >= fromMs && f.timestamp() <= toMs) {
                    result.add(f);
                }
            }
            return result;
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Return all available frames (full buffer). */
    public List<SimulationFrame> queryAll() {
        lock.readLock().lock();
        try {
            List<SimulationFrame> result = new ArrayList<>(size);
            int count = size;
            int start = (head - count + MAX_FRAMES) % MAX_FRAMES;
            for (int i = 0; i < count; i++) {
                SimulationFrame f = ring[(start + i) % MAX_FRAMES];
                if (f != null) result.add(f);
            }
            return result;
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Oldest timestamp currently in the buffer, or -1 if empty. */
    public long oldestTimestamp() {
        lock.readLock().lock();
        try {
            if (size == 0) return -1;
            int oldest = (head - size + MAX_FRAMES) % MAX_FRAMES;
            SimulationFrame f = ring[oldest];
            return f != null ? f.timestamp() : -1;
        } finally {
            lock.readLock().unlock();
        }
    }

    /** Newest timestamp currently in the buffer, or -1 if empty. */
    public long newestTimestamp() {
        lock.readLock().lock();
        try {
            if (size == 0) return -1;
            int newest = (head - 1 + MAX_FRAMES) % MAX_FRAMES;
            SimulationFrame f = ring[newest];
            return f != null ? f.timestamp() : -1;
        } finally {
            lock.readLock().unlock();
        }
    }

    public int getSize() {
        lock.readLock().lock();
        try { return size; } finally { lock.readLock().unlock(); }
    }

    public void clear() {
        lock.writeLock().lock();
        try {
            for (int i = 0; i < ring.length; i++) ring[i] = null;
            head = 0;
            size = 0;
        } finally {
            lock.writeLock().unlock();
        }
    }
}
