#!/bin/sh
# demo stub: prints what would deploy where
echo "deploying '${DEPLOY_REF}' to ${1:-?} (vault: ${VAULT_ADDR:-unset})"
