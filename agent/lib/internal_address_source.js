/*
 * Copyright 2016 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var http = require('http');
var util = require('util');
var events = require('events');
var kubernetes = require('./kubernetes.js');
var log = require('./log.js').logger();
var myutils = require('./utils.js');

function extract_address(object) {
    try {
        return JSON.parse(object.data['config.json']);
    } catch (e) {
        console.error('Failed to parse config.json for address: %s %j', e, object);
    }
}

function extract_spec(def) {
    if (def.spec === undefined) {
        console.error('no spec found on %j', def);
    }
    var o = myutils.merge(def.spec, {status:def.status});
    o.name = def.metadata ? def.metadata.name : def.address;
    if (def.metadata && def.metadata.annotations && def.metadata.annotations['enmasse.io/broker-id']) {
        o.allocated_to = def.metadata.annotations['enmasse.io/broker-id'];
    }
    return o;
}

function extract_address_field(object) {
    var def = extract_address(object);
    return def && def.spec ? def.spec.address : undefined;
}

function is_defined (addr) {
    return addr !== undefined;
}

function ready (addr) {
    return addr && addr.status && addr.status.phase !== 'Terminating' && addr.status.phase !== 'Pending';
}

function same_address_definition(a, b) {
    return a.address === b.address && a.type === b.type && a.allocated_to === b.allocated_to;
}

function same_address_status(a, b) {
    if (a === undefined) return b === undefined;
    return a.isReady === b.isReady && a.phase === b.phase && a.message === b.message;
}

function same_address_definition_and_status(a, b) {
    return same_address_definition(a, b) && same_address_status(a.status, b.status);
}

function address_compare(a, b) {
    return myutils.string_compare(a.address, b.address);
}

function configmap_compare(a, b) {
    return myutils.string_compare(a.metadata.name, b.metadata.name);
}

function by_address(a) {
    return a.address;
}

function description(list) {
    const max = 5;
    if (list.length > max) {
        return list.slice(0, max).map(by_address).join(', ') + ' and ' + (list.length - max) + ' more';
    } else {
        return JSON.stringify(list.map(by_address));
    }
}

function AddressSource(address_space, config) {
    this.address_space = address_space;
    this.config = config || {};
    var options = this.config;
    options.selector = 'type=address-config';
    events.EventEmitter.call(this);
    this.watcher = kubernetes.watch('configmaps', options);
    this.watcher.on('updated', this.updated.bind(this));
    this.readiness = {};
    this.last = {};
}

util.inherits(AddressSource, events.EventEmitter);

AddressSource.prototype.dispatch = function (name, addresses, unchanged) {
    var c = myutils.changes(this.last[name], addresses, address_compare, unchanged, description);
    this.last[name] = addresses;
    if (c) {
        log.info('%s: %s', name, c.description);
        this.emit(name, addresses);
    }
};

AddressSource.prototype.update_readiness = function (objects) {
    var self = this;

    objects.forEach(function (configmap) {
        var address = extract_address_field(configmap);
        var record = self.readiness[address];
        if (record === undefined) {
            record = {ready: false, address: address, name: configmap.metadata.name};
            self.readiness[address] = record;
        }
    });
};

AddressSource.prototype.updated = function (objects) {
    objects.sort(configmap_compare);
    log.debug('addresses updated: %j', objects);
    this.update_readiness(objects);
    this.dispatch('addresses_defined', objects.map(extract_address).filter(is_defined).map(extract_spec), same_address_definition_and_status);
    this.dispatch('addresses_ready', objects.map(extract_address).filter(ready).map(extract_spec), same_address_definition);
};

AddressSource.prototype.update_status = function (record, ready) {
    function update(configmap) {
        var def = JSON.parse(configmap.data['config.json']);
        if (def.status === undefined) {
            def.status = {};
        }
        if (def.status.isReady !== ready) {
            def.status.isReady = ready;
            def.status.phase = ready ? 'Active' : 'Pending';
            configmap.data['config.json'] = JSON.stringify(def);
            return configmap;
        } else {
            return undefined;
        }
    }
    return kubernetes.update('configmaps/' + record.name, update, this.config).then(function (result) {
        if (result === 200) {
            record.ready = ready;
            log.info('updated status for %j: %s', record, result);
        } else if (result === 304) {
            record.ready = ready;
            log.debug('no need to update status for %j: %s', record, result);
        } else {
            log.error('failed to update status for %j: %s', record, result);
        }
    }).catch(function (error) {
        log.error('failed to update status for %j: %j', record, error);
    });
};

AddressSource.prototype.check_status = function (address_stats) {
    for (var address in address_stats) {
        var record = this.readiness[address];
        var ready = address_stats[address].propagated === 100;
        if (record !== undefined && ready !== record.ready) {
            return this.update_status(record, ready);
        }
    }
};

function get_configmap_name_for_address(address) {
    return myutils.kubernetes_name(address);
}

AddressSource.prototype.create_address = function (definition) {
    var configmap_name = get_configmap_name_for_address(definition.address);
    var address = {
        apiVersion: 'enmasse.io/v1',
        kind: 'Address',
        metadata: {
            name: configmap_name,
            addressSpace: this.address_space
        },
        spec: {
            address: definition.address,
            type: definition.type,
            plan: definition.plan
        }
    };
    var configmap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
            name: configmap_name,
            labels: {
                type: 'address-config'
            },
            annotations: {
                addressSpace: this.address_space,
            },
        },
        data: {
            'config.json': JSON.stringify(address)
        }
    };
    return kubernetes.post('configmaps', configmap, this.config).then(function (result) {
        if (result >= 300) {
            return Promise.reject(new Error(util.format('Failed to created address %j: %d %s', definition, result, http.STATUS_CODES[result])));
        } else {
            return Promise.resolve();
        }
    });
};

AddressSource.prototype.delete_address = function (definition) {
    return kubernetes.delete_resource('configmaps/' + definition.name, this.config);
};

function extract_address_plan (object) {
    return JSON.parse(object.data.definition);
}

function display_order (plan_a, plan_b) {
    // explicitly ordered plans always come before those with undefined order
    var a = plan_a.displayOrder || Number.MAX_VALUE;
    var b = plan_b.displayOrder || Number.MAX_VALUE;
    return a - b;
}

function extract_plan_details (plan) {
    return {
        name: plan.metadata.name,
        displayName: plan.displayName || plan.metadata.name,
        shortDescription: plan.shortDescription,
        longDescription: plan.longDescription,
    };
}

AddressSource.prototype.get_address_types = function () {
    var options = this.config;
    options.selector = 'type=address-plan';
    return kubernetes.get('configmaps', options).then(function (configmaps) {
        //extract plans
        var plans = configmaps.items.map(extract_address_plan);
        plans.sort(display_order);
        //group by addressType
        var types = [];
        var by_type = plans.reduce(function (map, plan) {
            var list = map[plan.addressType];
            if (list === undefined) {
                list = [];
                map[plan.addressType] = list;
                types.push(plan.addressType);
            }
            list.push(plan);
            return map;
        }, {});
        var results = [];
        types.forEach(function (type) {
            results.push({name:type, plans:by_type[type].map(extract_plan_details)});
        });
        return results;
    });
};

module.exports = AddressSource;
