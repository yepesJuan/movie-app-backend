import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class AwsMovieAppBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Cognito User Pool
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
    });

    // Create AppSync API
    const api = new appsync.GraphqlApi(this, "MovieApi", {
      name: "movie-api",
      schema: appsync.SchemaFile.fromAsset("graphql/schema.graphql"),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
      },
    });

    // Create Movies DynamoDB Table
    const movieTable = new dynamodb.Table(this, "MovieTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Data Source for AppSync
    const dataSource = api.addDynamoDbDataSource("MovieDataSource", movieTable);

    // Attach Resolvers for CRUD Operations (with group-based authorization)

    // list all
    dataSource.createResolver("ListMoviesResolver", {
      typeName: "Query",
      fieldName: "listMovies",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
    #set($limit = $util.defaultIfNull($ctx.args.limit, 11))
    #if($ctx.identity.claims["cognito:groups"] && $ctx.identity.claims["cognito:groups"].contains("Admins"))
    {
      "version": "2018-05-29",
      "operation": "Scan",
      "limit": $limit
      #if($ctx.args.nextToken)
        , "nextToken": $util.toJson($ctx.args.nextToken)
      #end
    }
    #else
    {
      "version": "2018-05-29",
      "operation": "Scan",
      "limit": $limit,
      "filter": {
        "expression": "createdBy = :user",
        "expressionValues": {
          ":user": $util.dynamodb.toDynamoDBJson($ctx.identity.sub)
        }
      }
      #if($ctx.args.nextToken)
        , "nextToken": $util.toJson($ctx.args.nextToken)
      #end
    }
    #end
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
    #if($ctx.error)
      $util.error($ctx.error.message, $ctx.error.type)
    #end
    
    #if(!$ctx.result.items || $ctx.result.items.size() == 0)
      $util.toJson({
        "items": [],
        "nextToken": null
      })
    #else
      $util.toJson({
      "items": $ctx.result.items,
      "nextToken": $ctx.result.nextToken
    })
    #end
      `),
    });

    // get one by id
    dataSource.createResolver("GetMovieResolver", {
      typeName: "Query",
      fieldName: "getMovie",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2018-05-29",
          "operation": "GetItem",
          "key": {
            "id": $util.dynamodb.toDynamoDBJson($ctx.args.id)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        ## Check for errors
        #if($ctx.error)
          $util.error($ctx.error.message, $ctx.error.type)
        #end
        
        ## If the result is empty, the item doesn't exist
        #if(!$ctx.result)
          $util.error("Movie not found", "NotFound")
        #end
        
        ## If we have results, check permissions
        #set($isAdmin = false)
        #if($ctx.identity.claims["cognito:groups"])
          #foreach($group in $ctx.identity.claims["cognito:groups"])
            #if($group == "Admins")
              #set($isAdmin = true)
            #end
          #end
        #end
        
        #if($ctx.result.createdBy == $ctx.identity.sub || $isAdmin)
          $util.toJson($ctx.result)
        #else
          $util.error("Unauthorized to view this movie", "Unauthorized")
        #end
      `),
    });

    // create
    dataSource.createResolver("CreateMovieResolver", {
      typeName: "Mutation",
      fieldName: "createMovie",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2018-05-29",
          "operation": "PutItem",
          "key": {
            "id": $util.dynamodb.toDynamoDBJson($util.autoId())
          },
          "attributeValues": {
            "title": $util.dynamodb.toDynamoDBJson($ctx.args.title),
            "publishingYear": $util.dynamodb.toDynamoDBJson($ctx.args.publishingYear),
            "poster": $util.dynamodb.toDynamoDBJson($ctx.args.poster),
            "createdBy": $util.dynamodb.toDynamoDBJson($ctx.identity.sub),
            "createdByEmail": $util.dynamodb.toDynamoDBJson($ctx.identity.claims.email)
          }
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        #if($ctx.error)
          $util.error($ctx.error.message, $ctx.error.type, $ctx.result)
        #end
        
        $util.toJson($ctx.result)
      `),
    });

    // update
    dataSource.createResolver("UpdateMovieResolver", {
      typeName: "Mutation",
      fieldName: "updateMovie",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2018-05-29",
          "operation": "UpdateItem",
          "key": {
            "id": $util.dynamodb.toDynamoDBJson($ctx.args.id)
          },
          "update": {
            "expression": "SET title = :title, publishingYear = :year, poster = :poster",
            "expressionValues": {
              ":title": $util.dynamodb.toDynamoDBJson($ctx.args.title),
              ":year": $util.dynamodb.toDynamoDBJson($ctx.args.publishingYear),
              ":poster": $util.dynamodb.toDynamoDBJson($ctx.args.poster)
            }
          },
          "condition": {
            "expression": "attribute_exists(id)"
          },
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        ## Check for errors, including condition check failure (NotFound)
        #if($ctx.error)
          #if($ctx.error.type.equals("DynamoDB:ConditionalCheckFailedException"))
            $util.error("Movie not found", "NotFound")
          #else
            $util.error($ctx.error.message, $ctx.error.type)
          #end
        #end
        
        ## If we have results, check permissions
        #set($isAdmin = false)
        #if($ctx.identity.claims["cognito:groups"])
          #foreach($group in $ctx.identity.claims["cognito:groups"])
            #if($group == "Admins")
              #set($isAdmin = true)
            #end
          #end
        #end
        
        #if($ctx.result.createdBy == $ctx.identity.sub || $isAdmin)
          ## Update successful and authorized
          $util.toJson($ctx.result)
        #else
          $util.error("Unauthorized to update this movie", "Unauthorized")
        #end
      `),
    });

    // delete
    dataSource.createResolver("DeleteMovieResolver", {
      typeName: "Mutation",
      fieldName: "deleteMovie",
      requestMappingTemplate: appsync.MappingTemplate.fromString(`
        {
          "version": "2018-05-29",
          "operation": "DeleteItem",
          "key": {
            "id": $util.dynamodb.toDynamoDBJson($ctx.args.id)
          },
        }
      `),
      responseMappingTemplate: appsync.MappingTemplate.fromString(`
        #if($ctx.error)
          $util.error($ctx.error.message, $ctx.error.type)
        #end
      
        ## First check if the item exists
        #if(!$ctx.result)
          $util.error("Movie not found", "NotFound")
        #end
      
        #set($isAdmin = false)
        #if($ctx.identity.claims["cognito:groups"])
          #foreach($group in $ctx.identity.claims["cognito:groups"])
            #if($group == "Admins")
              #set($isAdmin = true)
            #end
          #end
        #end
      
        #if($ctx.result.createdBy == $ctx.identity.sub || $isAdmin)
          $util.toJson($ctx.result)
        #else
          $util.error("Unauthorized to delete this movie", "Unauthorized")
        #end
      `),
    });

    // Create S3 Bucket for Movie Posters
    const moviePosterBucket = new s3.Bucket(this, "MovieImageBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Output API & S3 Bucket Name
    new cdk.CfnOutput(this, "GraphQLAPIURL", { value: api.graphqlUrl });
    new cdk.CfnOutput(this, "MoviePosterBucketName", {
      value: moviePosterBucket.bucketName,
    });
  }
}
