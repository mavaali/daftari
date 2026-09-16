/*! @azure/msal-browser v5.20.0 2026-08-28 */
'use strict';
import { AuthError } from '../../msal-common/index-browser.mjs';

/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
function getDefaultErrorMessage(code) {
    return `See https://aka.ms/msal.js.errors#${code} for details`;
}
/**
 * Browser library error class thrown by the MSAL.js library for SPAs
 */
class BrowserAuthError extends AuthError {
    constructor(errorCode, correlationId, subError) {
        super(errorCode, correlationId, getDefaultErrorMessage(errorCode), subError);
        Object.setPrototypeOf(this, BrowserAuthError.prototype);
        this.name = "BrowserAuthError";
    }
}
function createBrowserAuthError(errorCode, correlationId, subError) {
    return new BrowserAuthError(errorCode, correlationId, subError);
}

export { BrowserAuthError, createBrowserAuthError, getDefaultErrorMessage };
