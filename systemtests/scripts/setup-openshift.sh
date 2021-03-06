#!/bin/bash
SCRIPTDIR=`dirname $0`

oc cluster down #for the case that cluster is already running

oc get status
if [ ! $? -ne 0 ]; then
    echo "ERROR: shutting down of openshift cluster failed, tests won't be executed"
    exit 1
fi

sudo rm -rf /var/lib/origin/openshift.local.pv
sudo rm -rf /var/log/containers/*
sudo rm -rf /var/log/pods/*

oc cluster up $OC_CLUSTER_ARGS
oc login -u system:admin

TIMEOUT=300
NOW=$(date +%s)
END=$(($NOW + $TIMEOUT))
echo "Now: $(date -d@${NOW} -u +%F:%H:%M:%S)"
echo "Waiting ${TIMEOUT} seconds until: $(date -d@${END} -u +%F:%H:%M:%S)"

oc cluster status
while [ $? -gt 0 ]
do
    NOW=$(date +%s)
    if [ ${NOW} -gt ${END} ]; then
        echo "ERROR: Timed out waiting for openshift cluster to come up!"
        exit 1
    fi
    sleep 5
    oc cluster status
done


sleep 30

oc get pv
