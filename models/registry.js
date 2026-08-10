const Client = require('./Client');
const Employee = require('./Employee');
const Service = require('./Service');
const Category = require('./Category');
const Appointment = require('./Appointment');
const Review = require('./Review');
const Settings = require('./Settings');
const User = require('./User');
const Notification = require('./Notification');

const schemas = { Client, Employee, Service, Category, Appointment, Review, Settings, User, Notification };

function getModels(connection) {
  const models = {};
  for (const [name, schema] of Object.entries(schemas)) {
    models[name] = connection.models[name] || connection.model(name, schema);
  }
  return models;
}

module.exports = { schemas, getModels };
