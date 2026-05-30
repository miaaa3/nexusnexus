package com.nexus.service;

public class MapImportException extends RuntimeException {
    public MapImportException(String message) {
        super(message);
    }

    public MapImportException(String message, Throwable cause) {
        super(message, cause);
    }
}
