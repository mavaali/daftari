/*! @azure/msal-browser v5.20.0 2026-08-28 */
'use strict';
import { AuthorizationCodeClient } from '../../msal-common/index-browser.mjs';

/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
class HybridSpaAuthorizationCodeClient extends AuthorizationCodeClient {
    constructor(config, performanceClient) {
        super(config, performanceClient);
        this.includeRedirectUri = false;
    }
}

export { HybridSpaAuthorizationCodeClient };
