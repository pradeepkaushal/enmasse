/*
 * Copyright 2016-2018, EnMasse authors.
 * License: Apache License 2.0 (see the file LICENSE or http://apache.org/licenses/LICENSE-2.0.html).
 */

package io.enmasse.systemtest.standard;

import io.enmasse.systemtest.AddressType;
import io.enmasse.systemtest.Destination;
import io.enmasse.systemtest.bases.StandardTestBase;
import io.enmasse.systemtest.amqp.AmqpClient;
import org.apache.qpid.proton.message.Message;
import org.junit.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

import static org.hamcrest.CoreMatchers.is;
import static org.junit.Assert.assertThat;

public class AnycastTest extends StandardTestBase {

    @Test
    public void testMultipleReceivers() throws Exception {
        Destination dest = Destination.anycast("anycastMultipleReceivers");
        setAddresses(dest);
        AmqpClient client1 = amqpClientFactory.createQueueClient();
        AmqpClient client2 = amqpClientFactory.createQueueClient();
        AmqpClient client3 = amqpClientFactory.createQueueClient();

        runAnycastTest(dest, client1, client2, client3);
    }

    @Test
    public void testRestApi() throws Exception {
        List<String> addresses = Arrays.asList("anycastRest1", "anycastRest2");
        Destination a1 = Destination.anycast(addresses.get(0));
        Destination a2 = Destination.anycast(addresses.get(1));

        runRestApiTest(addresses, a1, a2);
    }

    @Test
    public void testScaleRouterAutomatically() throws Exception {
        ArrayList<Destination> dest = new ArrayList<>();
        int destCount = 210;
        for (int i = 0; i < destCount; i = i + 5) {
            dest.add(Destination.anycast("small-anycast-" + i));//router credit = 0.01 => 200 * 0.01 = 2 pods
        }
        setAddresses(dest.toArray(new Destination[0]));
//        TODO once getAddressPlanConfig() method will be implemented
//        double requiredCredit = getAddressPlanConfig("standard-anycast").getRequiredCreditFromResource("router");
//        int replicasCount = (int) (destCount * requiredCredit);
//        waitForBrokerReplicas(sharedAddressSpace, dest.get(0), replicasCount);

        waitForRouterReplicas(sharedAddressSpace, 2);

        AmqpClient client1 = amqpClientFactory.createQueueClient();
        AmqpClient client2 = amqpClientFactory.createQueueClient();
        for (int i = 0; i < destCount; i++) {
            if (i % 5 == 0) {
                runAnycastTest(dest.get(i), client1, client2);
                Thread.sleep(2000);
            }
        }
    }

    public static void runAnycastTest(Destination dest, AmqpClient... clients) throws InterruptedException, TimeoutException, IOException, ExecutionException {
        if (clients.length == 0) {
            throw new IllegalStateException("Clients are required for this test");
        }
        List<String> msgs = new ArrayList<>();
        for (int i = 0; i < clients.length; i++) {
            msgs.add("message-anycast-" + i);
        }
        List<Future<List<Message>>> received = new ArrayList<>();
        for (AmqpClient client : clients) {
            received.add(client.recvMessages(dest.getAddress(), 1));
        }
        Future<Integer> sendResult = clients[0].sendMessages(dest.getAddress(), msgs);
        assertThat("Wrong count of messages sent", sendResult.get(1, TimeUnit.MINUTES), is(msgs.size()));
        for (int i = 0; i < received.size(); i++) {
            assertThat("Wrong count of messages received: receiver" + i,
                    received.get(i).get(1, TimeUnit.MINUTES).size(), is(1));
        }
    }
}
