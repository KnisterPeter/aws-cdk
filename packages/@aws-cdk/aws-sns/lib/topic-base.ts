import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import sqs = require('@aws-cdk/aws-sqs');
import cdk = require('@aws-cdk/cdk');
import { IResource, Resource } from '@aws-cdk/cdk';
import { TopicPolicy } from './policy';
import { Subscription, SubscriptionProtocol } from './subscription';

export interface ITopic extends IResource {
  /**
   * @attribute
   */
  readonly topicArn: string;

  /**
   * @attribute
   */
  readonly topicName: string;

  /**
   * Subscribe some endpoint to this topic
   */
  subscribe(name: string, endpoint: string, protocol: SubscriptionProtocol, rawMessageDelivery?: boolean): Subscription;

  /**
   * Defines a subscription from this SNS topic to an SQS queue.
   *
   * The queue resource policy will be updated to allow this SNS topic to send
   * messages to the queue.
   *
   * @param queue The target queue
   * @param rawMessageDelivery Enable raw message delivery
   */
  subscribeQueue(queue: sqs.IQueue, rawMessageDelivery?: boolean): Subscription;

  /**
   * Defines a subscription from this SNS Topic to a Lambda function.
   *
   * The Lambda's resource policy will be updated to allow this topic to
   * invoke the function.
   *
   * @param lambdaFunction The Lambda function to invoke
   */
  subscribeLambda(lambdaFunction: lambda.IFunction): Subscription;

  /**
   * Defines a subscription from this SNS topic to an email address.
   *
   * @param name A name for the subscription
   * @param emailAddress The email address to use.
   * @param options Options to use for email subscription
   */
  subscribeEmail(name: string, emailAddress: string, options?: EmailSubscriptionOptions): Subscription;

  /**
   * Defines a subscription from this SNS topic to an http:// or https:// URL.
   *
   * @param name A name for the subscription
   * @param url The URL to invoke
   * @param rawMessageDelivery Enable raw message delivery
   */
  subscribeUrl(name: string, url: string, rawMessageDelivery?: boolean): Subscription;

  /**
   * Adds a statement to the IAM resource policy associated with this topic.
   *
   * If this topic was created in this stack (`new Topic`), a topic policy
   * will be automatically created upon the first call to `addToPolicy`. If
   * the topic is improted (`Topic.import`), then this is a no-op.
   */
  addToResourcePolicy(statement: iam.PolicyStatement): void;

  /**
   * Grant topic publishing permissions to the given identity
   */
  grantPublish(identity: iam.IGrantable): iam.Grant;
}

/**
 * Either a new or imported Topic
 */
export abstract class TopicBase extends Resource implements ITopic {
  public abstract readonly topicArn: string;

  public abstract readonly topicName: string;

  /**
   * Controls automatic creation of policy objects.
   *
   * Set by subclasses.
   */
  protected abstract readonly autoCreatePolicy: boolean;

  private policy?: TopicPolicy;

  /**
   * Subscribe some endpoint to this topic
   */
  public subscribe(name: string, endpoint: string, protocol: SubscriptionProtocol, rawMessageDelivery?: boolean): Subscription {
    return new Subscription(this, name, {
      topic: this,
      endpoint,
      protocol,
      rawMessageDelivery,
    });
  }

  /**
   * Defines a subscription from this SNS topic to an SQS queue.
   *
   * The queue resource policy will be updated to allow this SNS topic to send
   * messages to the queue.
   *
   * @param queue The target queue
   * @param rawMessageDelivery Enable raw message delivery
   */
  public subscribeQueue(queue: sqs.IQueue, rawMessageDelivery?: boolean): Subscription {
    if (!cdk.Construct.isConstruct(queue)) {
      throw new Error(`The supplied Queue object must be an instance of Construct`);
    }

    const subscriptionName = this.node.id + 'Subscription';
    if (queue.node.tryFindChild(subscriptionName)) {
      throw new Error(`A subscription between the topic ${this.node.id} and the queue ${queue.node.id} already exists`);
    }

    // we use the queue name as the subscription's. there's no meaning to subscribing
    // the same queue twice on the same topic. Create subscription under *consuming*
    // construct to make sure it ends up in the correct stack in cases of cross-stack subscriptions.
    const sub = new Subscription(queue, subscriptionName, {
      topic: this,
      endpoint: queue.queueArn,
      protocol: SubscriptionProtocol.Sqs,
      rawMessageDelivery,
    });

    // add a statement to the queue resource policy which allows this topic
    // to send messages to the queue.
    queue.addToResourcePolicy(new iam.PolicyStatement()
      .addResource(queue.queueArn)
      .addAction('sqs:SendMessage')
      .addServicePrincipal('sns.amazonaws.com')
      .setCondition('ArnEquals', { 'aws:SourceArn': this.topicArn }));

    return sub;
  }

  /**
   * Defines a subscription from this SNS Topic to a Lambda function.
   *
   * The Lambda's resource policy will be updated to allow this topic to
   * invoke the function.
   *
   * @param lambdaFunction The Lambda function to invoke
   */
  public subscribeLambda(lambdaFunction: lambda.IFunction): Subscription {
    if (!cdk.Construct.isConstruct(lambdaFunction)) {
      throw new Error(`The supplied lambda Function object must be an instance of Construct`);
    }

    const subscriptionName = this.node.id + 'Subscription';

    if (lambdaFunction.node.tryFindChild(subscriptionName)) {
      throw new Error(`A subscription between the topic ${this.node.id} and the lambda ${lambdaFunction.id} already exists`);
    }

    // Create subscription under *consuming* construct to make sure it ends up
    // in the correct stack in cases of cross-stack subscriptions.
    const sub = new Subscription(lambdaFunction, subscriptionName, {
      topic: this,
      endpoint: lambdaFunction.functionArn,
      protocol: SubscriptionProtocol.Lambda,
    });

    lambdaFunction.addPermission(this.node.id, {
      sourceArn: this.topicArn,
      principal: new iam.ServicePrincipal('sns.amazonaws.com'),
    });

    return sub;
  }

  /**
   * Defines a subscription from this SNS topic to an email address.
   *
   * @param name A name for the subscription
   * @param emailAddress The email address to use.
   * @param options Options for the email delivery format.
   */
  public subscribeEmail(name: string, emailAddress: string, options?: EmailSubscriptionOptions): Subscription {
    const protocol = (options && options.json ? SubscriptionProtocol.EmailJson : SubscriptionProtocol.Email);

    return new Subscription(this, name, {
      topic: this,
      endpoint: emailAddress,
      protocol
    });
  }

  /**
   * Defines a subscription from this SNS topic to an http:// or https:// URL.
   *
   * @param name A name for the subscription
   * @param url The URL to invoke
   * @param rawMessageDelivery Enable raw message delivery
   */
  public subscribeUrl(name: string, url: string, rawMessageDelivery?: boolean): Subscription {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('URL must start with either http:// or https://');
    }

    const protocol = url.startsWith('https:') ? SubscriptionProtocol.Https : SubscriptionProtocol.Http;

    return new Subscription(this, name, {
      topic: this,
      endpoint: url,
      protocol,
      rawMessageDelivery,
    });
  }

  /**
   * Adds a statement to the IAM resource policy associated with this topic.
   *
   * If this topic was created in this stack (`new Topic`), a topic policy
   * will be automatically created upon the first call to `addToPolicy`. If
   * the topic is improted (`Topic.import`), then this is a no-op.
   */
  public addToResourcePolicy(statement: iam.PolicyStatement) {
    if (!this.policy && this.autoCreatePolicy) {
      this.policy = new TopicPolicy(this, 'Policy', { topics: [ this ] });
    }

    if (this.policy) {
      this.policy.document.addStatement(statement);
    }
  }

  /**
   * Grant topic publishing permissions to the given identity
   */
  public grantPublish(grantee: iam.IGrantable) {
    return iam.Grant.addToPrincipalOrResource({
      grantee,
      actions: ['sns:Publish'],
      resourceArns: [this.topicArn],
      resource: this,
    });
  }

}

/**
 * Options for email subscriptions.
 */
export interface EmailSubscriptionOptions {
  /**
   * Indicates if the full notification JSON should be sent to the email
   * address or just the message text.
   *
   * @default Message text (false)
   */
  readonly json?: boolean;
}
