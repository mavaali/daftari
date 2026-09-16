/*! @azure/msal-common v16.14.0 2026-08-28 */
'use strict';
/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
async function getClientAssertion(clientAssertion, clientId, tokenEndpoint, fmiPath) {
    if (typeof clientAssertion === "string") {
        return clientAssertion;
    }
    else {
        const config = {
            clientId: clientId,
            tokenEndpoint: tokenEndpoint,
            fmiPath: fmiPath,
        };
        return clientAssertion(config);
    }
}

export { getClientAssertion };
