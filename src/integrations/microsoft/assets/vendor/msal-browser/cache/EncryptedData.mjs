/*! @azure/msal-browser v5.20.0 2026-08-28 */
'use strict';
/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
function isEncrypted(data) {
    return (data.hasOwnProperty("id") &&
        data.hasOwnProperty("nonce") &&
        data.hasOwnProperty("data"));
}

export { isEncrypted };
