/*! @azure/msal-browser v5.20.0 2026-08-28 */
'use strict';
import { AuthError } from '../../msal-common/index-browser.mjs';
import { getDefaultErrorMessage } from './BrowserAuthError.mjs';

/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
/**
 * Browser library error class thrown by the MSAL.js library for SPAs
 */
class BrowserConfigurationAuthError extends AuthError {
    constructor(errorCode, correlationId, errorMessage) {
        super(errorCode, correlationId, errorMessage);
        this.name = "BrowserConfigurationAuthError";
        Object.setPrototypeOf(this, BrowserConfigurationAuthError.prototype);
    }
}
function createBrowserConfigurationAuthError(errorCode, correlationId) {
    return new BrowserConfigurationAuthError(errorCode, correlationId, getDefaultErrorMessage(errorCode));
}

export { BrowserConfigurationAuthError, createBrowserConfigurationAuthError };
